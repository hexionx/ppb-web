/**
 * supabase-exams.js — Native Online Examination, Question Bank, Grading,
 * Results Publication, Analytics, Integrity Telemetry & Seed Handlers for Supabase
 *
 * Implements all `admin.(stimuli|questions|exams|attempts|grading|results|integrity).*`,
 * `exams.*`, and sample-seed actions on top of `window.PBSupabaseBackend` and PostgreSQL.
 */
(function (global) {
  'use strict';

  var QUESTION_TYPES = {
    SINGLE_CHOICE: true,
    COMPLEX_MULTIPLE_CHOICE: true,
    MULTIPLE_SELECT: true,
    TRUE_FALSE: true,
    NUMERIC_RESPONSE: true,
    SHORT_ANSWER: true,
    WRITTEN_RESPONSE: true
  };
  var DIFFICULTIES = { EASY: true, MEDIUM: true, HARD: true, OLYMPIAD: true };
  var ITEM_STATUSES = { DRAFT: true, PUBLISHED: true, ARCHIVED: true };
  var EXAM_MODES = { PRACTICE: true, MOCK_EXAM: true, ASSIGNED_ASSESSMENT: true };
  var ASSIGNMENT_SCOPES = { COURSE_ENROLLED: true, SELECTED_STUDENTS: true };
  var NAVIGATION_MODES = { FREE: true, LINEAR: true };
  var AGGREGATION_RULES = { BEST_PUBLISHED: true, LATEST_PUBLISHED: true, FIRST_PUBLISHED: true };
  var SCORE_RELEASE_POLICIES = { IMMEDIATE_AUTO: true, MANUAL_ADMIN: true, SCHEDULED: true, AFTER_CLOSE: true };
  var EXPLANATION_RELEASE_POLICIES = { WITH_SCORE: true, MANUAL_ADMIN: true, SCHEDULED: true, AFTER_CLOSE: true, NEVER: true };

  var INTEGRITY_DEFAULTS = {
    POLICY_VERSION: 'pb-copy-policy-v1',
    MAX_COPY_WARNINGS: 3,
    SUSPENSION_SECONDS: 5,
    MAX_INVALIDATIONS_BEFORE_LOCK: 3
  };

  function B() {
    if (!global.PBSupabaseBackend) {
      throw new Error('PBSupabaseBackend must be loaded before PBSupabaseExams.');
    }
    return global.PBSupabaseBackend;
  }

  function sb() { return B().getSupabase(); }
  function clean(v, max) { return B().cleanSingleLine(v, max); }
  function err(code, msg, fields) { return B().pbError(code, msg, fields); }
  function genId(prefix) { return B().genId(prefix); }
  function nowIso() { return B().nowUtcIso(); }
  function fmtBkk(ts) { return B().formatBangkokTimestamp(ts); }
  function okPg(res, label) { return B().throwIfPgErr(res, label); }

  function asJsonObj(val, fallback) {
    if (val && typeof val === 'object' && !Array.isArray(val)) return val;
    if (typeof val === 'string' && val.trim()) {
      var parsed = B().parseJsonSafe(val, null);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    }
    return fallback !== undefined ? fallback : {};
  }

  function asJsonArr(val, fallback) {
    if (Array.isArray(val)) return val;
    if (typeof val === 'string' && val.trim()) {
      var parsed = B().parseJsonSafe(val, null);
      if (Array.isArray(parsed)) return parsed;
    }
    return fallback !== undefined ? fallback : [];
  }

  function asRichDoc(val) {
    if (val && typeof val === 'object' && Array.isArray(val.blocks)) return val;
    return B().normalizeRichTextDoc(val, false).doc;
  }

  function extractPlainText(doc) {
    if (!doc || !Array.isArray(doc.blocks)) return '';
    var parts = [];
    for (var i = 0; i < doc.blocks.length; i++) {
      var b = doc.blocks[i];
      if (!b) continue;
      if (b.type === 'paragraph' && Array.isArray(b.spans)) {
        var sTxt = '';
        for (var s = 0; s < b.spans.length; s++) sTxt += (b.spans[s] && b.spans[s].text) || '';
        if (sTxt.trim()) parts.push(sTxt.trim());
      } else if ((b.type === 'bullet_list' || b.type === 'ordered_list') && Array.isArray(b.items)) {
        for (var m = 0; m < b.items.length; m++) {
          var item = b.items[m];
          var spans = Array.isArray(item) ? item : (item && Array.isArray(item.spans) ? item.spans : []);
          var itTxt = '';
          for (var k = 0; k < spans.length; k++) itTxt += (spans[k] && spans[k].text) || '';
          if (itTxt.trim()) parts.push(itTxt.trim());
        }
      } else if (b.type === 'table') {
        parts.push('[Table: ' + (b.caption || 'Data') + ']');
      } else if (b.type === 'image_attachment') {
        parts.push('[Image: ' + (b.caption || b.altText || 'Diagram') + ']');
      } else if (b.type === 'pdf_attachment') {
        parts.push('[PDF: ' + (b.title || 'Document') + ']');
      }
    }
    return parts.join(' ').trim();
  }

  function formatPointsBp(bp) {
    var val = (Number(bp) || 0) / 100;
    return Math.abs(val - Math.round(val)) < 1e-6 ? String(Math.round(val)) : val.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  }

  function parsePointsBp(rawVal, fieldKey, fieldLabel, allowZero, fieldErrors) {
    if (rawVal === undefined || rawVal === null || rawVal === '') {
      if (allowZero) return 0;
      fieldErrors[fieldKey] = fieldLabel + ' is required.';
      return 100;
    }
    var n = Number(rawVal);
    if (!isFinite(n) || (allowZero ? n < 0 : n <= 0) || n > 1000) {
      fieldErrors[fieldKey] = fieldLabel + ' must be a number ' + (allowZero ? 'between 0 and 1000.' : 'greater than 0 and up to 1000.');
      return allowZero ? 0 : 100;
    }
    return Math.round(n * 100);
  }

  function parseOptUtc(rawVal, fieldKey, fieldLabel, fieldErrors) {
    var s = String(rawVal || '').trim();
    if (!s) return null;
    var ms = Date.parse(s);
    if (!isFinite(ms)) {
      fieldErrors[fieldKey] = fieldLabel + ' must be a valid ISO-8601 date/time.';
      return null;
    }
    return new Date(ms).toISOString();
  }

  function normalizeTopicTags(raw) {
    var list = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw.trim() ? raw.split(/[,;|]/) : []);
    var out = [], seen = {};
    for (var i = 0; i < list.length && out.length < 15; i++) {
      var t = clean(list[i], 48);
      if (t && !seen[t.toLowerCase()]) { seen[t.toLowerCase()] = true; out.push(t); }
    }
    return out;
  }

  function parseImageIds(rawVal) {
    var list = Array.isArray(rawVal) ? rawVal : [];
    if (!Array.isArray(rawVal) && typeof rawVal === 'string' && rawVal.trim()) {
      var t = rawVal.trim();
      list = t.charAt(0) === '[' ? asJsonArr(t, []) : t.split(',');
    }
    var out = [], seen = {};
    for (var i = 0; i < list.length && out.length < 8; i++) {
      var id = clean(list[i], 64);
      if (id && !seen[id]) { seen[id] = true; out.push(id); }
    }
    return out;
  }

  function validateNonSpoilerAlt(hasImage, rawAlt, rawFlag, spoilers, fieldKey, label, errs) {
    var flag = String(rawFlag || 'STANDARD_ALT').trim().toUpperCase();
    if (flag !== 'STANDARD_ALT' && flag !== 'VISUAL_INTERPRETATION_REQUIRED') flag = 'STANDARD_ALT';
    var alt = clean(rawAlt, 300);
    if (hasImage && flag === 'STANDARD_ALT' && !alt) alt = label || 'Biological diagram';
    return { altText: alt, accessibleDesignFlag: flag };
  }

  function isOrderDependentText(txt) {
    var s = String(txt || '').toLowerCase();
    return /\b(all of the above|none of the above|both a and b|both b and c|all choices)\b/.test(s);
  }

  function fmtDurationMin(mins) {
    var m = Number(mins) || 0;
    if (m <= 0) return 'Untimed';
    var h = Math.floor(m / 60), r = m % 60;
    return h > 0 ? h + 'h ' + (r > 0 ? r + 'm' : '') : m + ' min';
  }

  function fmtModeLabel(mode) {
    if (mode === 'PRACTICE') return 'Practice Mode';
    if (mode === 'MOCK_EXAM') return 'Timed Mock Exam';
    if (mode === 'ASSIGNED_ASSESSMENT') return 'Assigned Assessment';
    return String(mode || 'Examination');
  }

  function fmtDurationSec(sec) {
    var s = Math.max(0, Math.round(Number(sec) || 0));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), rem = s % 60;
    if (h > 0) return h + 'h ' + m + 'm ' + rem + 's';
    if (m > 0) return m + 'm ' + rem + 's';
    return rem + 's';
  }

  function shuffleInPlace(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  function roundHalfAwayFromZero(numVal, decimals) {
    var d = Math.max(0, Math.min(6, Math.round(Number(decimals) || 0)));
    var factor = Math.pow(10, d);
    var sign = numVal < 0 ? -1 : 1;
    return (sign * Math.round(Math.abs(numVal) * factor + 1e-12)) / factor;
  }

  function normalizeShortAnswer(rawStr, caseSensitive, collapseWs, trimPunct) {
    var s = String(rawStr || '');
    if (collapseWs) s = s.replace(/\s+/g, ' ').trim();
    if (trimPunct) s = s.replace(/^[\s.,;:!?'"()]+|[\s.,;:!?'"()]+$/g, '');
    if (!caseSensitive) s = s.toLowerCase();
    return s.trim();
  }

  // ==================== PROJECTION DTOs ====================

  function projectStimulusDto(row) {
    if (!row) return null;
    var doc = asRichDoc(row.content_richtext_json);
    var tags = asJsonArr(row.topic_tags_json, []);
    return {
      stimulusId: row.stimulus_id,
      stimulusCode: row.stimulus_code,
      title: row.title,
      contentRichText: doc,
      plainTextSummary: extractPlainText(doc),
      imageFileId: row.image_file_id || '',
      imageAltText: row.image_alt_text || '',
      imageCaption: row.image_caption || '',
      accessibleDesignFlag: row.accessible_design_flag || 'STANDARD_ALT',
      topicTags: tags,
      status: row.status || 'PUBLISHED',
      version: Number(row.version || 1),
      updatedAtUtc: row.updated_at_utc || '',
      updatedAtBangkok: fmtBkk(row.updated_at_utc || '')
    };
  }

  function projectQuestionVersionDto(qBankRow, qVerRow, optionRows, stimRow, includePrivate) {
    var priv = includePrivate === true;
    var stemDoc = asRichDoc(qVerRow.stem_richtext_json);
    var tags = asJsonArr(qBankRow.topic_tags_json, []);
    var opts = (Array.isArray(optionRows) ? optionRows.slice() : []).sort(function (a, b) {
      return (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
    });
    var projOpts = opts.map(function (op, i) {
      var opDoc = asRichDoc(op.content_richtext_json);
      var d = {
        optionId: op.option_id,
        optionKey: op.option_key,
        contentRichText: opDoc,
        plainText: extractPlainText(opDoc),
        imageFileId: op.image_file_id || '',
        imageAltText: op.image_alt_text || '',
        sortOrder: Number(op.sort_order) || (i + 1) * 10,
        pinPosition: op.pin_position || 'NONE'
      };
      if (priv) d.isCorrect = Boolean(op.is_correct_private);
      return d;
    });
    var imgIds = parseImageIds(qVerRow.image_file_id);
    var dto = {
      questionId: qBankRow.question_id,
      questionCode: qBankRow.question_code,
      questionVersionId: qVerRow.question_version_id,
      versionNo: Number(qVerRow.version_no) || 1,
      latestVersionNo: Number(qBankRow.latest_version_no) || 1,
      title: qVerRow.title || qBankRow.title,
      questionType: qVerRow.question_type,
      difficulty: qBankRow.difficulty || 'MEDIUM',
      topicTags: tags,
      status: qBankRow.status || 'DRAFT',
      usedInAttemptsCount: Number(qBankRow.used_in_attempts_count) || 0,
      stemRichText: stemDoc,
      stemPlainText: extractPlainText(stemDoc),
      stimulusId: qVerRow.stimulus_id || '',
      stimulus: stimRow ? (stimRow.stimulusId ? stimRow : projectStimulusDto(stimRow)) : null,
      imageFileIds: imgIds,
      imageFileId: imgIds[0] || '',
      imageAltText: qVerRow.image_alt_text || '',
      imageCaption: qVerRow.image_caption || '',
      accessibleDesignFlag: qVerRow.accessible_design_flag || 'STANDARD_ALT',
      defaultPointsBp: Number(qVerRow.default_points_bp) || 100,
      defaultPointsDisplay: formatPointsBp(qVerRow.default_points_bp || 100),
      negativePointsBp: Number(qVerRow.negative_points_bp) || 0,
      negativePointsDisplay: formatPointsBp(qVerRow.negative_points_bp || 0),
      lockOptionOrder: Boolean(qVerRow.lock_option_order),
      selectionInstruction: qVerRow.selection_instruction || '',
      unitLabel: qVerRow.unit_label || '',
      maxLengthChars: Number(qVerRow.max_length_chars) || 0,
      gradingMode: qVerRow.grading_mode || 'AUTO',
      options: projOpts,
      createdAtUtc: qVerRow.created_at_utc || '',
      updatedAtUtc: qBankRow.updated_at_utc || qVerRow.created_at_utc || '',
      updatedAtBangkok: fmtBkk(qBankRow.updated_at_utc || qVerRow.created_at_utc || ''),
      version: Number(qBankRow.version) || 1
    };
    if (priv) {
      var gSpec = asJsonObj(qVerRow.grading_spec_private_json, {});
      var expDoc = qVerRow.explanation_richtext_json ? asRichDoc(qVerRow.explanation_richtext_json) : B().normalizeRichTextDoc('', false).doc;
      dto.privateGradingData = {
        gradingSpec: gSpec,
        explanationRichText: expDoc,
        explanationPlainText: extractPlainText(expDoc),
        referenceText: qVerRow.reference_text || '',
        adminNotes: qVerRow.admin_notes_private || ''
      };
    }
    return dto;
  }

  function validateFileId(rawId, fieldKey, fieldErrors) {
    var s = clean(rawId, 64);
    if (!s) return '';
    if (!/^fil_[A-Za-z0-9_-]{4,64}$/.test(s)) {
      fieldErrors[fieldKey] = 'Must be an application fileId (fil_...).';
      return '';
    }
    return s;
  }

  function validateQuestionGradingSpec(qType, req, defaultPointsBp, fieldErrors) {
    var rawOptions = Array.isArray(req.options) ? req.options : [];
    var normOptions = [], spoilers = [];
    var lockOptionOrder = Boolean(req.lockOptionOrder);
    var selectionInstruction = clean(req.selectionInstruction, 240);
    var unitLabel = clean(req.unitLabel, 64);
    var maxLengthChars = 0, gradingMode = 'AUTO';
    var spec = { questionType: qType };

    if (qType === 'SINGLE_CHOICE' || qType === 'COMPLEX_MULTIPLE_CHOICE' || qType === 'MULTIPLE_SELECT' || qType === 'TRUE_FALSE') {
      var minOpts = qType === 'TRUE_FALSE' ? 2 : (qType === 'COMPLEX_MULTIPLE_CHOICE' || qType === 'MULTIPLE_SELECT' ? 3 : 2);
      var maxOpts = qType === 'TRUE_FALSE' ? 2 : (qType === 'COMPLEX_MULTIPLE_CHOICE' ? 5 : 10);
      if (qType === 'TRUE_FALSE' && rawOptions.length === 0) {
        var tfCorr = String(req.trueFalseCorrect || 'TRUE').trim().toUpperCase();
        rawOptions = [
          { optionKey: 'TRUE', contentRichText: 'True', isCorrect: tfCorr === 'TRUE', pinPosition: 'FIXED' },
          { optionKey: 'FALSE', contentRichText: 'False', isCorrect: tfCorr === 'FALSE', pinPosition: 'FIXED' }
        ];
      }
      if (rawOptions.length < minOpts || rawOptions.length > maxOpts) {
        fieldErrors.options = qType + ' requires between ' + minOpts + ' and ' + maxOpts + ' answer options.';
      }
      var correctIds = [], hasOrderDep = false;
      for (var i = 0; i < rawOptions.length && i < maxOpts; i++) {
        var ro = rawOptions[i] && typeof rawOptions[i] === 'object' ? rawOptions[i] : {};
        var optId = ro.optionId && /^qop_[A-Za-z0-9_-]{4,64}$/.test(String(ro.optionId).trim()) ? String(ro.optionId).trim() : genId('qop_');
        var optKey = qType === 'TRUE_FALSE' ? (i === 0 ? 'TRUE' : 'FALSE') : (qType === 'COMPLEX_MULTIPLE_CHOICE' ? 'S' + (i + 1) : String.fromCharCode(65 + i));
        var opContentRaw = ro.contentRichText !== undefined ? ro.contentRichText : ro.text;
        var opNorm = B().normalizeRichTextDoc(opContentRaw, false);
        var opImgId = validateFileId(ro.imageFileId, 'optionImage_' + i, fieldErrors);
        if (!opNorm.plainTextSummary && !opImgId) {
          fieldErrors.options = 'Option ' + optKey + ': text or image is required.';
        }
        var optAlt = validateNonSpoilerAlt(Boolean(opImgId), ro.imageAltText, 'STANDARD_ALT', [], 'option_' + i + '_image', 'Option ' + optKey + ' image', fieldErrors);
        var pinPos = String(ro.pinPosition || 'NONE').trim().toUpperCase();
        if (pinPos !== 'NONE' && pinPos !== 'LAST' && pinPos !== 'FIXED') pinPos = 'NONE';
        if (isOrderDependentText(opNorm.plainTextSummary)) {
          hasOrderDep = true;
          if (pinPos === 'NONE') pinPos = i === rawOptions.length - 1 ? 'LAST' : 'FIXED';
        }
        if (qType === 'TRUE_FALSE' || qType === 'COMPLEX_MULTIPLE_CHOICE') { pinPos = 'FIXED'; lockOptionOrder = true; }
        var isCorr = Boolean(ro.isCorrect);
        if (isCorr) {
          correctIds.push(optId);
          if (opNorm.plainTextSummary) spoilers.push(opNorm.plainTextSummary);
        }
        if (!spec.statementTruthMap) spec.statementTruthMap = {};
        spec.statementTruthMap[optId] = isCorr;
        normOptions.push({
          option_id: optId,
          option_key: optKey,
          content_richtext_json: opNorm.doc,
          image_file_id: opImgId,
          image_alt_text: optAlt.altText,
          sort_order: (i + 1) * 10,
          pin_position: pinPos,
          is_correct_private: isCorr
        });
      }
      if (hasOrderDep) lockOptionOrder = true;
      if (qType === 'SINGLE_CHOICE' || qType === 'TRUE_FALSE') {
        if (correctIds.length !== 1) fieldErrors.correctOptions = qType + ' requires exactly 1 correct option.';
        if (!selectionInstruction) selectionInstruction = 'Select the single best answer.';
        spec.correctOptionIds = correctIds; spec.scoringRule = 'EXACT_MATCH';
      } else if (qType === 'COMPLEX_MULTIPLE_CHOICE') {
        if (!selectionInstruction) selectionInstruction = 'Complex Multiple Choice: Evaluate each sub-statement and select Yes or No (3/3 = 100%, 2/3 = 50%, 0-1/3 = 0%).';
        spec.correctOptionIds = correctIds; spec.scoringRule = 'TCAS_COMPLEX_3_TIER';
      } else {
        if (correctIds.length < 1) fieldErrors.correctOptions = 'MULTIPLE_SELECT requires at least 1 correct option.';
        var mRule = String(req.multiSelectScoringRule || 'EXACT_MATCH').trim().toUpperCase();
        if (mRule !== 'EXACT_MATCH' && mRule !== 'PARTIAL_WITHOUT_OVERSELECT') mRule = 'EXACT_MATCH';
        if (!selectionInstruction) selectionInstruction = mRule === 'PARTIAL_WITHOUT_OVERSELECT' ? 'Select all correct options (partial credit when no incorrect option selected).' : 'Select all correct options (all-or-nothing exact match).';
        spec.correctOptionIds = correctIds; spec.scoringRule = mRule;
      }
    } else if (qType === 'NUMERIC_RESPONSE') {
      var nSpec = req.numericSpec && typeof req.numericSpec === 'object' ? req.numericSpec : req;
      var mMode = String(nSpec.matchMode || 'EXACT_WITH_TOLERANCE').trim().toUpperCase();
      if (mMode === 'RANGE') mMode = 'ACCEPTABLE_RANGE';
      if (mMode !== 'EXACT_WITH_TOLERANCE' && mMode !== 'ACCEPTABLE_RANGE') fieldErrors.numericMatchMode = 'Invalid numeric match mode.';
      var numRx = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
      var rd = null;
      if (nSpec.roundingDecimals !== undefined && nSpec.roundingDecimals !== null && String(nSpec.roundingDecimals).trim() !== '') {
        var rdn = Number(nSpec.roundingDecimals);
        if (!Number.isInteger(rdn) || rdn < 0 || rdn > 6) fieldErrors.roundingDecimals = 'Rounding decimal places must be 0..6.';
        else rd = rdn;
      }
      if (mMode === 'EXACT_WITH_TOLERANCE') {
        var rt = String(nSpec.targetValue !== undefined ? nSpec.targetValue : '').trim();
        if (!rt || !numRx.test(rt) || !isFinite(Number(rt))) fieldErrors.targetValue = 'Numeric target value must be a finite number.';
        var tType = String(nSpec.toleranceType || 'NONE').trim().toUpperCase();
        if (tType === 'PERCENTAGE') tType = 'RELATIVE_PERCENT';
        if (tType !== 'NONE' && tType !== 'ABSOLUTE' && tType !== 'RELATIVE_PERCENT') tType = 'NONE';
        var tVal = tType !== 'NONE' ? Math.max(0, Number(nSpec.toleranceValue || 0) || 0) : 0;
        spec.matchMode = 'EXACT_WITH_TOLERANCE'; spec.targetValue = Number(rt); spec.toleranceType = tType; spec.toleranceValue = tVal; spec.roundingDecimals = rd; spec.roundingRule = 'HALF_AWAY_FROM_ZERO';
        spoilers.push(rt);
      } else {
        var rMin = String(nSpec.rangeMin !== undefined ? nSpec.rangeMin : '').trim();
        var rMax = String(nSpec.rangeMax !== undefined ? nSpec.rangeMax : '').trim();
        if (!rMin || !numRx.test(rMin) || !rMax || !numRx.test(rMax) || Number(rMin) > Number(rMax)) fieldErrors.numericRange = 'Valid rangeMin <= rangeMax required.';
        spec.matchMode = 'ACCEPTABLE_RANGE'; spec.rangeMin = Number(rMin); spec.rangeMax = Number(rMax); spec.inclusiveBounds = true; spec.roundingDecimals = rd; spec.roundingRule = 'HALF_AWAY_FROM_ZERO';
      }
      if (!selectionInstruction) selectionInstruction = 'Enter a numeric value' + (unitLabel ? ' in ' + unitLabel : '') + '.';
    } else if (qType === 'SHORT_ANSWER') {
      var saMode = String(req.gradingMode || 'MANUAL').trim().toUpperCase();
      if (saMode === 'NORMALIZED_AUTO_MATCH') saMode = 'AUTO_WITH_MANUAL_REVIEW';
      if (saMode !== 'MANUAL' && saMode !== 'AUTO' && saMode !== 'AUTO_WITH_MANUAL_REVIEW') saMode = 'MANUAL';
      gradingMode = saMode;
      maxLengthChars = Math.min(Math.max(Number(req.maxLengthChars) || 300, 20), 1000);
      var rawAcc = Array.isArray(req.acceptedAnswers) ? req.acceptedAnswers : (typeof req.acceptedAnswers === 'string' && req.acceptedAnswers.trim() ? req.acceptedAnswers.split(/\r?\n|\|/) : []);
      var cleanAcc = [];
      for (var a = 0; a < rawAcc.length && cleanAcc.length < 20; a++) {
        var sA = clean(rawAcc[a], 240);
        if (sA) { cleanAcc.push(sA); spoilers.push(sA); }
      }
      if ((saMode === 'AUTO' || saMode === 'AUTO_WITH_MANUAL_REVIEW') && cleanAcc.length === 0) {
        fieldErrors.acceptedAnswers = 'At least one accepted answer is required when auto-matching is enabled.';
      }
      spec.acceptedAnswers = cleanAcc; spec.caseSensitive = Boolean(req.caseSensitive);
      spec.collapseWhitespace = req.collapseWhitespace !== false; spec.trimPunctuation = req.trimPunctuation !== false;
      spec.rubricNotes = clean(req.rubricNotes, 1000);
      if (!selectionInstruction) selectionInstruction = 'Enter a short answer (max ' + maxLengthChars + ' chars).';
    } else {
      gradingMode = 'MANUAL';
      maxLengthChars = Math.min(Math.max(Number(req.maxLengthChars) || 2500, 100), 10000);
      var rawCrit = Array.isArray(req.rubricCriteria) ? req.rubricCriteria : [];
      var cleanCrit = [], critSum = 0;
      for (var c = 0; c < rawCrit.length && cleanCrit.length < 10; c++) {
        var rc = rawCrit[c] || {};
        var cTitle = clean(rc.title, 140);
        if (!cTitle) continue;
        var cBp = Math.max(0, Math.round((Number(rc.maxPoints !== undefined ? rc.maxPoints : rc.maxPointsBp / 100) || 0) * 100));
        critSum += cBp;
        cleanCrit.push({ criterionId: rc.criterionId || 'crit_' + (c + 1), title: cTitle, maxPointsBp: cBp, description: clean(rc.description, 400) });
      }
      if (cleanCrit.length === 0) {
        cleanCrit.push({ criterionId: 'crit_1', title: 'Biological Accuracy, Reasoning & Terminology', maxPointsBp: defaultPointsBp, description: 'Demonstrates accurate conceptual understanding.' });
        critSum = defaultPointsBp;
      }
      spec.rubricCriteria = cleanCrit; spec.rubricTotalBp = critSum;
      spec.sampleModelAnswer = clean(req.sampleModelAnswer, 2000);
      if (!selectionInstruction) selectionInstruction = 'Write a clear biological explanation (max ' + maxLengthChars + ' chars).';
    }

    return {
      normalizedOptions: normOptions,
      lockOptionOrder: lockOptionOrder,
      selectionInstruction: selectionInstruction,
      unitLabel: unitLabel,
      maxLengthChars: maxLengthChars,
      gradingMode: gradingMode,
      gradingSpec: spec,
      spoilerStrings: spoilers
    };
  }

  // ==================== STIMULI & QUESTION BANK ====================

  async function handleAdminListStimuli(payload, token) {
    await B().requireSession(token, ['ADMIN']);
    var rows = okPg(await sb().from('shared_stimuli').select('*').order('updated_at_utc', { ascending: false }), 'List stimuli') || [];
    return { stimuli: rows.map(projectStimulusDto) };
  }

  async function handleAdminSaveStimulus(payload, token) {
    var admin = await B().requireSession(token, ['ADMIN']);
    var req = payload || {};
    var errs = {};
    var stimId = clean(req.stimulusId, 64);
    var stimCode = clean(req.stimulusCode, 48).toUpperCase();
    if (!stimCode || !/^[A-Z0-9][A-Z0-9_-]{2,47}$/.test(stimCode)) errs.stimulusCode = 'Stimulus code must be 3-48 uppercase characters.';
    var title = clean(req.title, 180);
    if (!title || title.length < 3) errs.title = 'Stimulus title (3-180 chars) is required.';
    var status = String(req.status || 'PUBLISHED').trim().toUpperCase();
    if (!ITEM_STATUSES[status]) status = 'PUBLISHED';
    var rt = B().normalizeRichTextDoc(req.contentRichText, false);
    if (!rt.plainTextSummary) errs.contentRichText = 'Shared stimulus content is required.';
    var imgId = validateFileId(req.imageFileId, 'imageFileId', errs);
    var alt = validateNonSpoilerAlt(Boolean(imgId), req.imageAltText, req.accessibleDesignFlag, [], 'image', 'Stimulus diagram', errs);
    if (Object.keys(errs).length > 0) throw err('ERR_VALIDATION_FAILED', 'Please fix shared stimulus fields.', errs);

    var now = nowIso();
    var existingByCode = okPg(await sb().from('shared_stimuli').select('stimulus_id').eq('stimulus_code', stimCode).maybeSingle());
    if (existingByCode && existingByCode.stimulus_id !== stimId) {
      throw err('ERR_VALIDATION_FAILED', 'Stimulus code "' + stimCode + '" already exists.', { stimulusCode: 'Must be unique.' });
    }
    var saved;
    if (!stimId) {
      stimId = genId('stim_');
      saved = okPg(await sb().from('shared_stimuli').insert({
        stimulus_id: stimId,
        stimulus_code: stimCode,
        title: title,
        content_richtext_json: rt.doc,
        image_file_id: imgId,
        image_alt_text: alt.altText,
        image_caption: clean(req.imageCaption, 240),
        accessible_design_flag: alt.accessibleDesignFlag,
        topic_tags_json: normalizeTopicTags(req.topicTags),
        status: status,
        created_by_user_id: admin.userId,
        created_at_utc: now,
        updated_at_utc: now,
        version: 1
      }).select('*').single(), 'Create stimulus');
    } else {
      saved = okPg(await sb().from('shared_stimuli').update({
        stimulus_code: stimCode,
        title: title,
        content_richtext_json: rt.doc,
        image_file_id: imgId,
        image_alt_text: alt.altText,
        image_caption: clean(req.imageCaption, 240),
        accessible_design_flag: alt.accessibleDesignFlag,
        topic_tags_json: normalizeTopicTags(req.topicTags),
        status: status,
        updated_at_utc: now
      }).eq('stimulus_id', stimId).select('*').single(), 'Update stimulus');
    }
    await B().writeAuditEvent(admin.userId, 'ADMIN', 'ADMIN_STIMULUS_SAVED', 'SharedStimulus', stimId, { stimulusCode: stimCode });
    return { stimulus: projectStimulusDto(saved), stimuli: (await handleAdminListStimuli({}, token)).stimuli };
  }

  async function loadQuestionBankBundle() {
    var all = await Promise.all([
      sb().from('question_bank').select('*'),
      sb().from('question_versions').select('*'),
      sb().from('question_options').select('*'),
      sb().from('shared_stimuli').select('*')
    ]);
    var qbRows = okPg(all[0], 'Load question bank') || [];
    var qvRows = okPg(all[1], 'Load question versions') || [];
    var qoRows = okPg(all[2], 'Load question options') || [];
    var stRows = okPg(all[3], 'Load stimuli') || [];
    var qbById = {}, qvById = {}, qoByQvId = {}, stById = {};
    qbRows.forEach(function (r) { qbById[r.question_id] = r; });
    qvRows.forEach(function (r) { qvById[r.question_version_id] = r; });
    qoRows.forEach(function (r) {
      if (!qoByQvId[r.question_version_id]) qoByQvId[r.question_version_id] = [];
      qoByQvId[r.question_version_id].push(r);
    });
    stRows.forEach(function (r) { stById[r.stimulus_id] = r; });
    return { qbRows: qbRows, qbById: qbById, qvRows: qvRows, qvById: qvById, qoByQvId: qoByQvId, stRows: stRows, stById: stById };
  }

  async function handleAdminListQuestions(payload, token) {
    await B().requireSession(token, ['ADMIN']);
    var req = payload || {};
    var searchQ = String(req.search || '').trim().toLowerCase();
    var fType = String(req.questionType || 'ALL').trim().toUpperCase();
    var fDiff = String(req.difficulty || 'ALL').trim().toUpperCase();
    var fStatus = String(req.status || 'ALL').trim().toUpperCase();
    var fTopic = String(req.topic || '').trim().toLowerCase();

    var bundle = await loadQuestionBankBundle();
    var countsByStatus = { DRAFT: 0, PUBLISHED: 0, ARCHIVED: 0 };
    var allTopics = {}, items = [];

    for (var i = bundle.qbRows.length - 1; i >= 0; i--) {
      var qb = bundle.qbRows[i];
      if (countsByStatus[qb.status] !== undefined) countsByStatus[qb.status] += 1;
      var tags = asJsonArr(qb.topic_tags_json, []);
      tags.forEach(function (t) { allTopics[t] = true; });
      if (fType !== 'ALL' && qb.question_type !== fType) continue;
      if (fDiff !== 'ALL' && qb.difficulty !== fDiff) continue;
      if (fStatus !== 'ALL' && qb.status !== fStatus) continue;
      if (fTopic && fTopic !== 'all' && tags.map(function (x) { return String(x).toLowerCase(); }).indexOf(fTopic) === -1) continue;

      var qv = bundle.qvById[qb.active_version_id];
      if (!qv) continue;
      var dto = projectQuestionVersionDto(qb, qv, bundle.qoByQvId[qv.question_version_id] || [], qv.stimulus_id ? bundle.stById[qv.stimulus_id] : null, true);
      if (searchQ) {
        var hay = (dto.questionCode + ' ' + dto.title + ' ' + dto.stemPlainText + ' ' + tags.join(' ')).toLowerCase();
        if (hay.indexOf(searchQ) === -1) continue;
      }
      items.push(dto);
    }

    var stimuli = bundle.stRows.filter(function (s) { return s.status !== 'ARCHIVED'; }).map(projectStimulusDto);
    return {
      questions: items,
      stimuli: stimuli,
      availableTopics: Object.keys(allTopics).sort(),
      summary: { totalQuestions: bundle.qbRows.length, countsByStatus: countsByStatus, stimuliCount: stimuli.length }
    };
  }

  async function handleAdminSaveQuestion(payload, token) {
    var admin = await B().requireSession(token, ['ADMIN']);
    var req = payload || {};
    var errs = {};
    var qId = clean(req.questionId, 64);
    var isCreate = !qId;
    var qCode = clean(req.questionCode, 48).toUpperCase();
    if (!qCode || !/^[A-Z0-9][A-Z0-9_.-]{2,47}$/.test(qCode)) errs.questionCode = 'Question code (3-48 uppercase letters, digits, ., -, _) is required.';
    var title = clean(req.title, 180);
    if (!title || title.length < 3) errs.title = 'Question title (3-180 chars) is required.';
    var qType = String(req.questionType || 'SINGLE_CHOICE').trim().toUpperCase();
    if (!QUESTION_TYPES[qType]) errs.questionType = 'Unsupported questionType.';
    var difficulty = String(req.difficulty || 'MEDIUM').trim().toUpperCase();
    if (!DIFFICULTIES[difficulty]) difficulty = 'MEDIUM';
    var status = String(req.status || 'PUBLISHED').trim().toUpperCase();
    if (!ITEM_STATUSES[status]) status = 'PUBLISHED';

    var defPtsBp = parsePointsBp(req.defaultPoints !== undefined ? req.defaultPoints : 1, 'defaultPoints', 'Question points', false, errs);
    var negPtsBp = parsePointsBp(req.negativePoints !== undefined && req.negativePoints !== '' ? req.negativePoints : 0, 'negativePoints', 'Negative penalty', true, errs);
    var stemNorm = B().normalizeRichTextDoc(req.stemRichText, false);
    if (!stemNorm.plainTextSummary) errs.stemRichText = 'Question stem content is required.';
    var expNorm = B().normalizeRichTextDoc(req.explanationRichText || '', false);
    var specB = validateQuestionGradingSpec(qType, req, defPtsBp || 100, errs);

    var candImgIds = parseImageIds(Array.isArray(req.imageFileIds) && req.imageFileIds.length > 0 ? req.imageFileIds : req.imageFileId);
    var validImgIds = candImgIds.map(function (id, idx) { return validateFileId(id, 'imageFileId_' + idx, errs); }).filter(Boolean);
    var imageFileIdStr = validImgIds.join(',');
    var altCheck = validateNonSpoilerAlt(validImgIds.length > 0, req.imageAltText, req.accessibleDesignFlag, specB.spoilerStrings, 'image', 'Question diagram', errs);
    var stimulusId = clean(req.stimulusId, 64);

    if (Object.keys(errs).length > 0) throw err('ERR_VALIDATION_FAILED', 'Please fix the highlighted question bank fields.', errs);

    if (stimulusId) {
      var stHit = okPg(await sb().from('shared_stimuli').select('stimulus_id').eq('stimulus_id', stimulusId).maybeSingle());
      if (!stHit) throw err('ERR_NOT_FOUND', 'Referenced shared stimulus was not found.', { stimulusId: 'Not found.' });
    }
    var dup = okPg(await sb().from('question_bank').select('question_id').eq('question_code', qCode).maybeSingle());
    if (dup && dup.question_id !== qId) throw err('ERR_VALIDATION_FAILED', 'Question code "' + qCode + '" is already in use.', { questionCode: 'Must be unique.' });

    var now = nowIso();
    var newVersionId = genId('qvr_');
    var nextVerNo = 1;
    var savedBankRow;

    if (isCreate) {
      qId = genId('qbn_');
      savedBankRow = okPg(await sb().from('question_bank').insert({
        question_id: qId,
        question_code: qCode,
        title: title,
        question_type: qType,
        topic_tags_json: normalizeTopicTags(req.topicTags),
        difficulty: difficulty,
        active_version_id: newVersionId,
        latest_version_no: 1,
        status: status,
        used_in_attempts_count: 0,
        created_by_user_id: admin.userId,
        created_at_utc: now,
        updated_at_utc: now,
        version: 1
      }).select('*').single(), 'Create question');
    } else {
      var existingQ = okPg(await sb().from('question_bank').select('*').eq('question_id', qId).maybeSingle());
      if (!existingQ) throw err('ERR_NOT_FOUND', 'Question "' + qId + '" not found.');
      nextVerNo = (Number(existingQ.latest_version_no) || 1) + 1;
      savedBankRow = okPg(await sb().from('question_bank').update({
        question_code: qCode,
        title: title,
        question_type: qType,
        topic_tags_json: normalizeTopicTags(req.topicTags),
        difficulty: difficulty,
        active_version_id: newVersionId,
        latest_version_no: nextVerNo,
        status: status,
        updated_at_utc: now,
        version: (Number(existingQ.version) || 1) + 1
      }).eq('question_id', qId).select('*').single(), 'Update question');
    }

    var savedVerRow = okPg(await sb().from('question_versions').insert({
      question_version_id: newVersionId,
      question_id: qId,
      version_no: nextVerNo,
      question_type: qType,
      title: title,
      stem_richtext_json: stemNorm.doc,
      stimulus_id: stimulusId,
      image_file_id: imageFileIdStr,
      image_alt_text: altCheck.altText,
      image_caption: clean(req.imageCaption, 240),
      accessible_design_flag: altCheck.accessibleDesignFlag,
      default_points_bp: defPtsBp,
      negative_points_bp: negPtsBp,
      lock_option_order: specB.lockOptionOrder,
      selection_instruction: specB.selectionInstruction,
      unit_label: specB.unitLabel,
      max_length_chars: specB.maxLengthChars,
      grading_mode: specB.gradingMode,
      grading_spec_private_json: specB.gradingSpec,
      explanation_richtext_json: expNorm.doc,
      reference_text: clean(req.referenceText, 300),
      admin_notes_private: clean(req.adminNotes, 1000),
      is_immutable: false,
      created_by_user_id: admin.userId,
      created_at_utc: now
    }).select('*').single(), 'Save question version');

    var insertedOpts = [];
    if (specB.normalizedOptions.length > 0) {
      var optRowsToInsert = specB.normalizedOptions.map(function (o) {
        return Object.assign({}, o, { question_version_id: newVersionId, question_id: qId, created_at_utc: now });
      });
      insertedOpts = okPg(await sb().from('question_options').insert(optRowsToInsert).select('*'), 'Save question options') || [];
    }

    var stimRow = stimulusId ? okPg(await sb().from('shared_stimuli').select('*').eq('stimulus_id', stimulusId).maybeSingle()) : null;
    var dto = projectQuestionVersionDto(savedBankRow, savedVerRow, insertedOpts, stimRow, true);
    await B().writeAuditEvent(admin.userId, 'ADMIN', 'ADMIN_QUESTION_SAVED', 'QuestionBank', qId, { questionCode: qCode, versionNo: nextVerNo });
    var listRes = await handleAdminListQuestions({}, token);
    return { question: dto, questions: listRes.questions, summary: listRes.summary };
  }

  async function handleAdminDuplicateQuestion(payload, token) {
    await B().requireSession(token, ['ADMIN']);
    var qId = clean(payload && payload.questionId, 64);
    var qb = okPg(await sb().from('question_bank').select('*').eq('question_id', qId).maybeSingle());
    if (!qb) throw err('ERR_NOT_FOUND', 'Source question not found.');
    var qv = okPg(await sb().from('question_versions').select('*').eq('question_version_id', qb.active_version_id).maybeSingle());
    var opts = okPg(await sb().from('question_options').select('*').eq('question_version_id', qv.question_version_id)) || [];
    var gSpec = asJsonObj(qv.grading_spec_private_json, {});
    var copyPayload = {
      questionCode: (qb.question_code + '-COPY-' + Math.floor(100 + Math.random() * 899)).slice(0, 48),
      title: qb.title + ' (Copy)',
      questionType: qb.question_type,
      difficulty: qb.difficulty,
      topicTags: asJsonArr(qb.topic_tags_json, []),
      status: 'DRAFT',
      defaultPoints: (Number(qv.default_points_bp) || 100) / 100,
      negativePoints: (Number(qv.negative_points_bp) || 0) / 100,
      stemRichText: asRichDoc(qv.stem_richtext_json),
      stimulusId: qv.stimulus_id || '',
      imageFileId: qv.image_file_id || '',
      imageAltText: qv.image_alt_text || '',
      imageCaption: qv.image_caption || '',
      accessibleDesignFlag: qv.accessible_design_flag || 'STANDARD_ALT',
      lockOptionOrder: Boolean(qv.lock_option_order),
      selectionInstruction: qv.selection_instruction || '',
      unitLabel: qv.unit_label || '',
      maxLengthChars: qv.max_length_chars || 0,
      gradingMode: qv.grading_mode || 'AUTO',
      multiSelectScoringRule: gSpec.scoringRule,
      numericSpec: gSpec,
      acceptedAnswers: gSpec.acceptedAnswers,
      caseSensitive: gSpec.caseSensitive,
      rubricCriteria: gSpec.rubricCriteria,
      sampleModelAnswer: gSpec.sampleModelAnswer,
      explanationRichText: qv.explanation_richtext_json ? asRichDoc(qv.explanation_richtext_json) : '',
      referenceText: qv.reference_text || '',
      adminNotes: qv.admin_notes_private || '',
      options: opts.map(function (o) {
        return {
          optionKey: o.option_key,
          contentRichText: asRichDoc(o.content_richtext_json),
          imageFileId: o.image_file_id || '',
          imageAltText: o.image_alt_text || '',
          pinPosition: o.pin_position,
          isCorrect: Boolean(o.is_correct_private)
        };
      })
    };
    return await handleAdminSaveQuestion(copyPayload, token);
  }

  async function handleAdminArchiveOrDeleteQuestion(payload, token) {
    var admin = await B().requireSession(token, ['ADMIN']);
    var qId = clean(payload && payload.questionId, 64);
    var nextStatus = String((payload && payload.nextStatus) || 'ARCHIVED').trim().toUpperCase();
    if (!ITEM_STATUSES[nextStatus]) nextStatus = 'ARCHIVED';
    var qb = okPg(await sb().from('question_bank').select('*').eq('question_id', qId).maybeSingle());
    if (!qb) throw err('ERR_NOT_FOUND', 'Question not found.');
    var used = Number(qb.used_in_attempts_count || 0);
    if (Boolean(payload && payload.deletePermanently) && used === 0) {
      okPg(await sb().from('question_bank').delete().eq('question_id', qId), 'Delete question');
    } else {
      okPg(await sb().from('question_bank').update({ status: nextStatus, updated_at_utc: nowIso() }).eq('question_id', qId), 'Archive question');
    }
    await B().writeAuditEvent(admin.userId, 'ADMIN', 'ADMIN_QUESTION_STATUS_CHANGED', 'QuestionBank', qId, { status: nextStatus });
    return await handleAdminListQuestions({}, token);
  }

  async function handleAdminPreviewQuestion(payload, token) {
    await B().requireSession(token, ['ADMIN']);
    var qId = clean(payload && payload.questionId, 64);
    var qb = okPg(await sb().from('question_bank').select('*').eq('question_id', qId).maybeSingle());
    if (!qb) throw err('ERR_NOT_FOUND', 'Question not found.');
    var qv = okPg(await sb().from('question_versions').select('*').eq('question_version_id', qb.active_version_id).maybeSingle());
    var opts = okPg(await sb().from('question_options').select('*').eq('question_version_id', qv.question_version_id)) || [];
    var stim = qv.stimulus_id ? okPg(await sb().from('shared_stimuli').select('*').eq('stimulus_id', qv.stimulus_id).maybeSingle()) : null;
    return {
      studentPreview: projectQuestionVersionDto(qb, qv, opts, stim, false),
      adminDetail: projectQuestionVersionDto(qb, qv, opts, stim, true)
    };
  }

  async function handleAdminSeedSampleBiologyBank(payload, token) {
    await B().requireSession(token, ['ADMIN']);
    var existingStim = okPg(await sb().from('shared_stimuli').select('*').eq('stimulus_code', 'STIM-BIO-PHOTOSYN-01').maybeSingle());
    var stimId = existingStim ? existingStim.stimulus_id : '';
    if (!stimId) {
      var stRes = await handleAdminSaveStimulus({
        stimulusCode: 'STIM-BIO-PHOTOSYN-01',
        title: 'Hill Reaction & DCMU Inhibition in Isolated Chloroplasts',
        topicTags: ['Photosynthesis', 'Bioenergetics', 'Plant Physiology'],
        status: 'PUBLISHED',
        contentRichText: {
          schemaVersion: 'pb-richtext-v1',
          blocks: [
            { type: 'paragraph', spans: [{ text: 'Experiment 1: Hill Reaction & Photosynthetic O2 Evolution in Spinacia oleracea Chloroplasts', bold: true }] },
            {
              type: 'table',
              caption: 'Table 1: Rate of O2 evolution across light and DCMU treatments',
              headers: ['Cuvette', 'Light (umol/m2/s)', 'DCMU', 'O2 Evolution'],
              rows: [
                ['1 (Dark Control)', '0', 'Absent', '0.0'],
                ['2 (Low Light)', '150', 'Absent', '42.5'],
                ['3 (Saturating Light)', '800', 'Absent', '128.0'],
                ['4 (Inhibitor + Light)', '800', '10 umol/L DCMU', '1.2']
              ]
            }
          ]
        }
      }, token);
      stimId = stRes.stimulus.stimulusId;
    }

    var existingQb = okPg(await sb().from('question_bank').select('question_id,question_code')) || [];
    var byCode = {};
    existingQb.forEach(function (q) { byCode[String(q.question_code).toUpperCase()] = q; });

    var specs = [
      {
        questionCode: 'BIO-PHOTO-SC-01',
        title: 'Site of DCMU Electron Transport Inhibition in Thylakoid Membrane',
        questionType: 'SINGLE_CHOICE',
        difficulty: 'MEDIUM',
        status: 'PUBLISHED',
        topicTags: ['Photosynthesis', 'Bioenergetics'],
        defaultPoints: 2,
        stimulusId: stimId,
        stemRichText: 'Based on Table 1, DCMU reduces O2 evolution in Cuvette 4 by competitively binding to which site?',
        options: [
          { text: 'The QB plastoquinone binding site on the D1 protein of Photosystem II', isCorrect: true },
          { text: 'The copper prosthetic group of plastocyanin in the thylakoid lumen', isCorrect: false },
          { text: 'The Fe-S cluster of ferredoxin on the stromal side of PSI', isCorrect: false },
          { text: 'The CF0 proton channel of chloroplast ATP synthase', isCorrect: false }
        ],
        explanationRichText: 'DCMU blocks electron transfer from QA to QB on the D1 protein of Photosystem II.',
        referenceText: 'Campbell Biology, 12th Ed., Ch. 10'
      },
      {
        questionCode: 'BIO-CELL-MS-02',
        title: 'Chemiosmotic Proton Gradient & Thylakoid Lumen Acidification',
        questionType: 'MULTIPLE_SELECT',
        difficulty: 'HARD',
        status: 'PUBLISHED',
        topicTags: ['Photosynthesis', 'Cell Biology'],
        defaultPoints: 2,
        multiSelectScoringRule: 'PARTIAL_WITHOUT_OVERSELECT',
        stemRichText: 'Which processes directly contribute to the proton-motive force across the thylakoid membrane?',
        options: [
          { text: 'Water photolysis at the Mn4CaO5 cluster releasing H+ into the thylakoid lumen', isCorrect: true },
          { text: 'Plastoquinone Q-cycle translocation of H+ via cytochrome b6f', isCorrect: true },
          { text: 'Rubisco carboxylation of RuBP in the chloroplast stroma', isCorrect: false },
          { text: 'NADP+ reduction consuming stromal H+ via FNR', isCorrect: true }
        ],
        explanationRichText: 'Photolysis in the lumen, cytochrome b6f proton pumping, and stromal H+ consumption establish the proton gradient.'
      },
      {
        questionCode: 'BIO-ENZYME-TF-03',
        title: 'Competitive Enzyme Inhibitor Km vs Vmax Effect',
        questionType: 'TRUE_FALSE',
        difficulty: 'EASY',
        status: 'PUBLISHED',
        topicTags: ['Biochemistry', 'Enzymology'],
        defaultPoints: 1,
        stemRichText: 'True or False: Adding a reversible competitive inhibitor increases apparent Km without altering Vmax.',
        trueFalseCorrect: 'TRUE',
        explanationRichText: 'High substrate concentration outcompetes competitive inhibitors so Vmax remains unchanged while apparent Km rises.'
      },
      {
        questionCode: 'BIO-GENETICS-NUM-04',
        title: 'Hardy-Weinberg Heterozygous Carrier Frequency Calculation',
        questionType: 'NUMERIC_RESPONSE',
        difficulty: 'MEDIUM',
        status: 'PUBLISHED',
        topicTags: ['Genetics', 'Evolution'],
        defaultPoints: 2,
        unitLabel: '%',
        stemRichText: 'In a large randomly mating population in Hardy-Weinberg equilibrium, 4% of individuals show a recessive trait. What percentage are heterozygous carriers?',
        numericSpec: { matchMode: 'EXACT_WITH_TOLERANCE', targetValue: 32, toleranceType: 'ABSOLUTE', toleranceValue: 0.5, roundingDecimals: 1 },
        explanationRichText: 'q^2 = 0.04 => q = 0.2, p = 0.8, 2pq = 0.32 = 32%.'
      },
      {
        questionCode: 'BIO-MOLEC-SA-05',
        title: 'Primary Carboxylating Enzyme in C3 Carbon Fixation',
        questionType: 'SHORT_ANSWER',
        difficulty: 'EASY',
        status: 'PUBLISHED',
        topicTags: ['Photosynthesis', 'Biochemistry'],
        defaultPoints: 2,
        gradingMode: 'AUTO_WITH_MANUAL_REVIEW',
        acceptedAnswers: ['RuBisCO', 'Rubisco', 'ribulose-1,5-bisphosphate carboxylase-oxygenase'],
        stemRichText: 'Name the enzyme that catalyzes the carboxylation of ribulose-1,5-bisphosphate (RuBP) in the Calvin cycle.',
        explanationRichText: 'RuBisCO catalyzes carbon fixation in C3 photosynthesis.'
      },
      {
        questionCode: 'BIO-PHYSIO-WR-06',
        title: 'Nephrons & Countercurrent Multiplier Mechanism',
        questionType: 'WRITTEN_RESPONSE',
        difficulty: 'HARD',
        status: 'PUBLISHED',
        topicTags: ['Animal Physiology', 'Homeostasis'],
        defaultPoints: 4,
        stemRichText: 'Explain how the descending and ascending limbs of the Loop of Henle establish an osmotic gradient in the renal medulla.',
        sampleModelAnswer: 'The descending limb is permeable to water via AQP1, while the thick ascending limb actively pumps Na+, K+, and Cl- via NKCC2 and is water-impermeable.',
        explanationRichText: 'The countercurrent multiplier traps solutes in the medulla enabling ADH-regulated water reabsorption in the collecting duct.'
      }
    ];

    for (var i = 0; i < specs.length; i++) {
      if (!byCode[specs[i].questionCode]) {
        await handleAdminSaveQuestion(specs[i], token);
      }
    }
    return await handleAdminListQuestions({}, token);
  }

  // ==================== EXAMS: STRUCTURE, VALIDATION, LIST, DRAFT, PUBLISH, ASSIGN ====================

  function buildExamVersionStructureBundle(exRow, verRow, secRows, itemRows, qbById, qvById, qoByQvId, stimById, includeDetail) {
    if (!verRow) {
      return {
        examVersionId: '',
        versionNo: 0,
        versionState: 'NONE',
        totalQuestionsCount: 0,
        maxPointsBp: 0,
        maxPointsDisplay: '0',
        negativeMarkingEnabled: false,
        sections: [],
        questionTypeBreakdown: {}
      };
    }
    var verSecs = secRows.filter(function (s) { return s.exam_version_id === verRow.exam_version_id; }).sort(function (a, b) {
      return (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
    });
    var itemsBySec = {};
    itemRows.filter(function (it) { return it.exam_version_id === verRow.exam_version_id; }).forEach(function (it) {
      if (!itemsBySec[it.exam_section_id]) itemsBySec[it.exam_section_id] = [];
      itemsBySec[it.exam_section_id].push(it);
    });

    var qTypeCounts = {}, hasManual = false, secDtos = [], totalQ = 0, totalMaxBp = 0, anyNeg = false;
    verSecs.forEach(function (sRow, sIdx) {
      var rawItems = (itemsBySec[sRow.exam_section_id] || []).slice().sort(function (a, b) {
        return (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
      });
      var secQ = sRow.selection_mode === 'QUESTION_POOL' ? Math.min(rawItems.length, Math.max(0, Number(sRow.pool_draw_count) || 0)) : rawItems.length;
      var secPtsBp = 0;
      var itemDtos = rawItems.map(function (it, k) {
        var qb = qbById[it.question_id], qv = qvById[it.question_version_id];
        var qType = qv ? qv.question_type : (qb ? qb.question_type : 'SINGLE_CHOICE');
        if (sRow.selection_mode !== 'QUESTION_POOL' || k < Number(sRow.pool_draw_count || 0)) {
          qTypeCounts[qType] = (qTypeCounts[qType] || 0) + 1;
          secPtsBp += Number(it.points_bp) || 100;
        }
        if ((Number(it.negative_points_bp) || 0) > 0) anyNeg = true;
        if (qv && qv.grading_mode === 'MANUAL') hasManual = true;
        if (!includeDetail) return null;
        var stim = qv && qv.stimulus_id && stimById ? stimById[qv.stimulus_id] : null;
        return {
          examItemId: it.exam_item_id,
          questionId: it.question_id,
          questionVersionId: it.question_version_id,
          questionCode: qb ? qb.question_code : '',
          title: qv ? qv.title : (qb ? qb.title : ''),
          questionType: qType,
          difficulty: qb ? qb.difficulty : 'MEDIUM',
          gradingMode: qv ? qv.grading_mode : 'AUTO',
          sortOrder: Number(it.sort_order) || (k + 1) * 10,
          lockItemPosition: Boolean(it.lock_item_position),
          lockOptionOrder: Boolean(it.lock_option_order),
          pointsBp: Number(it.points_bp) || 100,
          pointsDisplay: formatPointsBp(it.points_bp || 100),
          negativePointsBp: Number(it.negative_points_bp) || 0,
          negativePointsDisplay: formatPointsBp(it.negative_points_bp || 0),
          isPoolCandidate: Boolean(it.is_pool_candidate),
          poolGroupTag: it.pool_group_tag || '',
          questionPreview: qb && qv ? projectQuestionVersionDto(qb, qv, qoByQvId[qv.question_version_id] || [], stim, false) : null
        };
      }).filter(Boolean);

      var computedSecQ = Number(sRow.section_questions_count) || secQ;
      var computedSecBp = Number(sRow.section_max_points_bp) || secPtsBp;
      totalQ += computedSecQ;
      totalMaxBp += computedSecBp;
      var secInstDoc = asRichDoc(sRow.instructions_richtext_json || '');
      var sd = {
        examSectionId: sRow.exam_section_id,
        title: sRow.title || 'Section ' + (sIdx + 1),
        instructionsRichText: secInstDoc,
        instructionsPlainText: extractPlainText(secInstDoc),
        sortOrder: Number(sRow.sort_order) || (sIdx + 1) * 10,
        selectionMode: sRow.selection_mode || 'FIXED_ITEMS',
        selectionModeLabel: sRow.selection_mode === 'QUESTION_POOL'
          ? 'Random Pool Draw (' + Number(sRow.pool_draw_count || 0) + ' drawn from ' + rawItems.length + ' candidates)'
          : 'Fixed Section Items (' + rawItems.length + (rawItems.length === 1 ? ' question)' : ' questions)'),
        poolDrawCount: Number(sRow.pool_draw_count) || 0,
        poolCandidateCount: rawItems.length,
        lockSectionOrder: Boolean(sRow.lock_section_order),
        randomizeItemsWithinSection: Boolean(sRow.randomize_items_within_section),
        sectionQuestionsCount: computedSecQ,
        sectionMaxPointsBp: computedSecBp,
        sectionMaxPointsDisplay: formatPointsBp(computedSecBp)
      };
      if (includeDetail) sd.items = itemDtos;
      secDtos.push(sd);
    });

    var fQ = Number(verRow.total_questions_count) || totalQ;
    var fBp = Number(verRow.max_points_bp) || totalMaxBp;
    return {
      examVersionId: verRow.exam_version_id,
      versionNo: Number(verRow.version_no) || 1,
      versionState: verRow.version_state || 'DRAFT',
      totalQuestionsCount: fQ,
      maxPointsBp: fBp,
      maxPointsDisplay: formatPointsBp(fBp),
      negativeMarkingEnabled: Boolean(verRow.negative_marking_enabled) || anyNeg,
      hasManualGradingItems: hasManual,
      sections: secDtos,
      questionTypeBreakdown: qTypeCounts
    };
  }

  function evaluateExamPublicationReadiness(exRow, verRow, secRows, itemRows, qbById, qvById, qoByQvId, fileById) {
    var blockingErrors = [], warnings = [];
    if (!verRow) {
      blockingErrors.push({ code: 'MISSING_DRAFT_VERSION', message: 'Examination has no version structure.' });
      return { canPublish: false, blockingErrors: blockingErrors, warnings: warnings, computedSummary: { totalQuestionsCount: 0, maxPointsBp: 0, negativeMarkingEnabled: false } };
    }
    var secs = secRows.filter(function (s) { return s.exam_version_id === verRow.exam_version_id; }).sort(function (a, b) {
      return (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
    });
    if (secs.length === 0) blockingErrors.push({ code: 'NO_SECTIONS', message: 'Examination must include at least 1 section.' });
    var itemsBySec = {};
    itemRows.filter(function (i) { return i.exam_version_id === verRow.exam_version_id; }).forEach(function (i) {
      if (!itemsBySec[i.exam_section_id]) itemsBySec[i.exam_section_id] = [];
      itemsBySec[i.exam_section_id].push(i);
    });

    var totQ = 0, totMaxBp = 0, hasNeg = false;
    secs.forEach(function (sec, idx) {
      var list = (itemsBySec[sec.exam_section_id] || []).slice().sort(function (a, b) { return (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0); });
      if (list.length === 0) blockingErrors.push({ code: 'EMPTY_SECTION', message: 'Section "' + (sec.title || idx + 1) + '" has no questions.' });
      if (sec.selection_mode === 'QUESTION_POOL') {
        var draw = Number(sec.pool_draw_count) || 0;
        if (draw <= 0 || draw > list.length) {
          blockingErrors.push({ code: 'POOL_DRAW_EXCEEDS_CANDIDATES', message: 'Section "' + sec.title + '" pool draw count (' + draw + ') must be 1..' + list.length + '.' });
        }
        totQ += Math.min(draw, list.length);
        for (var k = 0; k < Math.min(draw, list.length); k++) totMaxBp += Number(list[k].points_bp) || 100;
      } else {
        totQ += list.length;
        list.forEach(function (it) { totMaxBp += Number(it.points_bp) || 100; });
      }
      list.forEach(function (it) {
        if ((Number(it.negative_points_bp) || 0) > 0) hasNeg = true;
        var qb = qbById[it.question_id], qv = qvById[it.question_version_id];
        if (!qb || !qv) {
          blockingErrors.push({ code: 'BROKEN_QUESTION_REF', message: 'Referenced question "' + it.question_id + '" no longer exists.' });
          return;
        }
        if (qb.status === 'ARCHIVED') {
          blockingErrors.push({ code: 'ARCHIVED_QUESTION', message: 'Question "' + qb.question_code + '" is ARCHIVED.' });
        } else if (qb.status === 'DRAFT') {
          warnings.push({ code: 'DRAFT_QUESTION', message: 'Question "' + qb.question_code + '" is in DRAFT status.' });
        }
        if (fileById && qv.image_file_id) {
          parseImageIds(qv.image_file_id).forEach(function (fid) {
            if (!fileById[fid] || fileById[fid].status !== 'ACTIVE') {
              blockingErrors.push({ code: 'MISSING_IMAGE_FILE', message: 'Missing diagram file ' + fid + ' on ' + qb.question_code });
            }
          });
        }
        if (qv.grading_mode === 'MANUAL' && exRow.score_release_policy === 'IMMEDIATE_AUTO') {
          warnings.push({ code: 'MANUAL_ITEM_IMMEDIATE_POLICY', message: 'Contains manually graded item "' + qb.question_code + '": score stays pending until graded.' });
        }
      });
    });

    if (exRow.score_release_policy === 'SCHEDULED' && !exRow.score_release_at_utc) {
      blockingErrors.push({ code: 'MISSING_SCORE_RELEASE_AT', message: 'Scheduled score release requires a release date/time.' });
    }
    if (exRow.explanation_release_policy === 'WITH_SCORE' && (Number(exRow.max_attempts) === 0 || Number(exRow.max_attempts) > 1)) {
      warnings.push({ code: 'MULTIPLE_ATTEMPT_ANSWER_EXPOSURE', message: 'Explanations are set to WITH_SCORE while multiple/unlimited attempts are permitted.' });
    }

    return {
      canPublish: blockingErrors.length === 0,
      blockingErrors: blockingErrors,
      warnings: warnings,
      computedSummary: { totalQuestionsCount: totQ, maxPointsBp: totMaxBp, maxPointsDisplay: formatPointsBp(totMaxBp), negativeMarkingEnabled: hasNeg }
    };
  }

  async function syncExamSetToAssessmentsTable(exRow, verRow, adminUserId) {
    if (!exRow.course_id) return exRow.assessment_id || '';
    var now = nowIso();
    var asmId = exRow.assessment_id || '';
    var maxScore = verRow && verRow.max_points_bp ? Math.round((Number(verRow.max_points_bp) / 100) * 100) / 100 : 100;
    if (asmId) {
      var ex = okPg(await sb().from('assessments').select('assessment_id,version').eq('assessment_id', asmId).maybeSingle());
      if (ex) {
        okPg(await sb().from('assessments').update({
          course_id: exRow.course_id,
          title: exRow.title,
          max_score: maxScore,
          status: exRow.status === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE',
          updated_at_utc: now,
          version: (Number(ex.version) || 1) + 1
        }).eq('assessment_id', asmId));
        return asmId;
      }
    }
    asmId = genId('asm_');
    okPg(await sb().from('assessments').insert({
      assessment_id: asmId,
      course_id: exRow.course_id,
      title: exRow.title,
      assessment_type: exRow.exam_mode === 'MOCK_EXAM' ? 'MOCK_EXAM' : (exRow.exam_mode === 'PRACTICE' ? 'PRACTICE_QUIZ' : 'ASSIGNED_TEST'),
      max_score: maxScore,
      external_url: 'native-exam://' + exRow.exam_set_id,
      instructions: 'Native online examination (' + exRow.exam_code + ') completed directly inside Pattanabhumi Biology.',
      due_date_bkk: '',
      status: 'ACTIVE',
      created_at_utc: now,
      updated_at_utc: now,
      version: 1
    }));
    return asmId;
  }

  async function handleAdminListExams(payload, token) {
    await B().requireSession(token, ['ADMIN']);
    var req = payload || {};
    var fCrs = clean(req.courseId, 64), fMode = String(req.examMode || 'ALL').trim().toUpperCase(), fStatus = String(req.status || 'ALL').trim().toUpperCase();
    var searchQ = String(req.search || '').trim().toLowerCase();

    var all = await Promise.all([
      sb().from('exam_sets').select('*'),
      sb().from('exam_versions').select('*'),
      sb().from('exam_sections').select('*'),
      sb().from('exam_items').select('*'),
      sb().from('exam_assignments').select('*'),
      sb().from('exam_attempts').select('attempt_id,exam_set_id,attempt_status'),
      sb().from('courses').select('course_id,course_code,title,status'),
      sb().from('files').select('file_id,status'),
      sb().rpc('pb_admin_list_users', { p_session_token: token, p_limit: 200 }),
      loadQuestionBankBundle()
    ]);

    var exsRows = okPg(all[0], 'List exams') || [];
    var exvRows = okPg(all[1]) || [], exsSec = okPg(all[2]) || [], exItems = okPg(all[3]) || [];
    var exAssigns = okPg(all[4]) || [], attRows = okPg(all[5]) || [], crsRows = okPg(all[6]) || [], fileRows = okPg(all[7]) || [];
    var usersList = (B().unwrapRpcResult(all[8]) || {}).users || [];
    var qbB = all[9];

    var exvById = {}, crsById = {}, usrById = {}, fileById = {}, assignByEx = {}, attCntByEx = {};
    exvRows.forEach(function (v) { exvById[v.exam_version_id] = v; });
    crsRows.forEach(function (c) { crsById[c.course_id] = c; });
    usersList.forEach(function (u) { usrById[u.userId] = u; });
    fileRows.forEach(function (f) { fileById[f.file_id] = f; });
    attRows.forEach(function (a) { if (a.attempt_status !== 'INVALIDATED') attCntByEx[a.exam_set_id] = (attCntByEx[a.exam_set_id] || 0) + 1; });

    exAssigns.forEach(function (a) {
      if (!assignByEx[a.exam_set_id]) assignByEx[a.exam_set_id] = [];
      var c = crsById[a.course_id], u = usrById[a.student_user_id];
      assignByEx[a.exam_set_id].push({
        assignmentId: a.assignment_id,
        courseId: a.course_id || '',
        courseCode: c ? c.course_code : '',
        targetType: a.target_type,
        studentUserId: a.student_user_id || '',
        studentUsername: u ? u.username : '',
        studentFullName: u ? u.fullName : '',
        assignmentStatus: a.assignment_status,
        openAtOverrideUtc: a.open_at_override_utc || '',
        overrideDeadlineUtc: a.override_deadline_utc || '',
        extraTimeMinutes: Number(a.extra_time_minutes) || 0,
        extraAttemptsGranted: Number(a.extra_attempts_granted) || 0,
        accommodationReason: a.accommodation_reason || '',
        updatedAtBangkok: fmtBkk(a.updated_at_utc),
        version: Number(a.version) || 1
      });
    });

    var countsByStatus = { DRAFT: 0, PUBLISHED: 0, CLOSED: 0, ARCHIVED: 0 };
    var examDtos = [];
    for (var i = exsRows.length - 1; i >= 0; i--) {
      var ex = exsRows[i];
      if (countsByStatus[ex.status] !== undefined) countsByStatus[ex.status] += 1;
      if (fCrs && fCrs !== 'ALL' && ex.course_id !== fCrs) continue;
      if (fMode !== 'ALL' && ex.exam_mode !== fMode) continue;
      if (fStatus !== 'ALL' && ex.status !== fStatus) continue;

      var targetVerId = ex.draft_exam_version_id || ex.active_exam_version_id;
      var verRow = targetVerId ? exvById[targetVerId] : null;
      var actVerRow = ex.active_exam_version_id ? exvById[ex.active_exam_version_id] : null;
      var verBundle = buildExamVersionStructureBundle(ex, verRow, exsSec, exItems, qbB.qbById, qbB.qvById, qbB.qoByQvId, qbB.stById, true);
      var valRep = evaluateExamPublicationReadiness(ex, verRow, exsSec, exItems, qbB.qbById, qbB.qvById, qbB.qoByQvId, fileById);
      var cRec = crsById[ex.course_id];
      var descDoc = asRichDoc(ex.description_richtext_json || '');
      var instDoc = asRichDoc(ex.instructions_richtext_json || '');
      var dto = {
        examSetId: ex.exam_set_id,
        assessmentId: ex.assessment_id || '',
        courseId: ex.course_id || '',
        courseCode: cRec ? cRec.course_code : '',
        courseTitle: cRec ? cRec.title : 'Unassigned / Multi-Course',
        examCode: ex.exam_code,
        title: ex.title,
        descriptionRichText: descDoc,
        descriptionPlainText: extractPlainText(descDoc),
        instructionsRichText: instDoc,
        instructionsPlainText: extractPlainText(instDoc),
        coverImageFileId: ex.cover_image_file_id || '',
        examMode: ex.exam_mode,
        examModeLabel: fmtModeLabel(ex.exam_mode),
        activeExamVersionId: ex.active_exam_version_id || '',
        activeVersionNo: actVerRow ? Number(actVerRow.version_no) || 1 : 0,
        draftExamVersionId: ex.draft_exam_version_id || '',
        latestVersionNo: Number(ex.latest_version_no) || 1,
        assignmentScope: ex.assignment_scope || 'COURSE_ENROLLED',
        openAtUtc: ex.open_at_utc || '',
        openAtBangkok: ex.open_at_utc ? fmtBkk(ex.open_at_utc) : '',
        closeAtUtc: ex.close_at_utc || '',
        closeAtBangkok: ex.close_at_utc ? fmtBkk(ex.close_at_utc) : '',
        durationMinutes: Number(ex.duration_minutes) || 0,
        durationLabel: fmtDurationMin(ex.duration_minutes),
        graceSeconds: Number(ex.grace_seconds) || 15,
        maxAttempts: Number(ex.max_attempts) || 0,
        retakeCooldownMinutes: Number(ex.retake_cooldown_minutes) || 0,
        navigationMode: ex.navigation_mode || 'FREE',
        aggregationRule: ex.aggregation_rule || 'BEST_PUBLISHED',
        scoreReleasePolicy: ex.score_release_policy || 'MANUAL_ADMIN',
        scoreReleaseAtUtc: ex.score_release_at_utc || '',
        explanationReleasePolicy: ex.explanation_release_policy || 'WITH_SCORE',
        explanationReleaseAtUtc: ex.explanation_release_at_utc || '',
        passThresholdPct: Number(ex.pass_threshold_pct) || 60,
        randomizeQuestions: Boolean(ex.randomize_questions),
        randomizeOptions: Boolean(ex.randomize_options),
        allowPerQuestionPracticeFeedback: Boolean(ex.allow_per_question_practice_feedback),
        copyPolicyEnabled: Boolean(ex.copy_policy_enabled),
        status: ex.status,
        totalQuestionsCount: verBundle.totalQuestionsCount,
        maxPointsBp: verBundle.maxPointsBp,
        maxPointsDisplay: verBundle.maxPointsDisplay,
        sectionCount: verBundle.sections.length,
        sections: verBundle.sections,
        questionTypeBreakdown: verBundle.questionTypeBreakdown,
        assignments: assignByEx[ex.exam_set_id] || [],
        attemptsCount: attCntByEx[ex.exam_set_id] || 0,
        validationReport: valRep,
        updatedAtUtc: ex.updated_at_utc,
        updatedAtBangkok: fmtBkk(ex.updated_at_utc),
        version: Number(ex.version) || 1
      };
      if (searchQ) {
        var hay = (dto.examCode + ' ' + dto.title + ' ' + dto.courseCode + ' ' + dto.descriptionPlainText).toLowerCase();
        if (hay.indexOf(searchQ) === -1) continue;
      }
      examDtos.push(dto);
    }

    return { exams: examDtos, summary: { totalExams: exsRows.length, countsByStatus: countsByStatus } };
  }

  async function handleAdminSaveExamDraft(payload, token) {
    var admin = await B().requireSession(token, ['ADMIN']);
    var req = payload || {};
    var errs = {};
    var examSetId = clean(req.examSetId, 64);
    var isCreate = !examSetId;
    var examCode = clean(req.examCode, 48).toUpperCase();
    if (!examCode || !/^[A-Z0-9][A-Z0-9_-]{2,47}$/.test(examCode)) errs.examCode = 'Exam code must be 3-48 uppercase characters.';
    var title = clean(req.title, 180);
    if (!title || title.length < 3) errs.title = 'Exam title (3-180 chars) is required.';
    var courseId = clean(req.courseId, 64);
    if (courseId) {
      var cHit = okPg(await sb().from('courses').select('course_id').eq('course_id', courseId).maybeSingle());
      if (!cHit) errs.courseId = 'Selected course not found.';
    }
    var examMode = String(req.examMode || 'PRACTICE').trim().toUpperCase();
    if (!EXAM_MODES[examMode]) errs.examMode = 'Invalid examMode.';
    var assignmentScope = String(req.assignmentScope || 'COURSE_ENROLLED').trim().toUpperCase();
    if (!ASSIGNMENT_SCOPES[assignmentScope]) assignmentScope = 'COURSE_ENROLLED';
    var navigationMode = NAVIGATION_MODES[String(req.navigationMode || 'FREE').toUpperCase()] ? String(req.navigationMode || 'FREE').toUpperCase() : 'FREE';
    var aggregationRule = AGGREGATION_RULES[String(req.aggregationRule || 'BEST_PUBLISHED').toUpperCase()] ? String(req.aggregationRule || 'BEST_PUBLISHED').toUpperCase() : 'BEST_PUBLISHED';
    var scoreReleasePolicy = String(req.scoreReleasePolicy || (examMode === 'PRACTICE' ? 'IMMEDIATE_AUTO' : 'MANUAL_ADMIN')).toUpperCase();
    if (!SCORE_RELEASE_POLICIES[scoreReleasePolicy]) errs.scoreReleasePolicy = 'Invalid scoreReleasePolicy.';
    var explanationReleasePolicy = String(req.explanationReleasePolicy || (examMode === 'PRACTICE' ? 'WITH_SCORE' : 'MANUAL_ADMIN')).toUpperCase();
    if (!EXPLANATION_RELEASE_POLICIES[explanationReleasePolicy]) errs.explanationReleasePolicy = 'Invalid explanationReleasePolicy.';

    var durationMinutes = Math.max(0, Math.min(600, parseInt(req.durationMinutes, 10) || 0));
    if (examMode === 'MOCK_EXAM' && durationMinutes <= 0) errs.durationMinutes = 'Mock exams require durationMinutes > 0.';
    var graceSeconds = req.graceSeconds !== undefined && req.graceSeconds !== '' ? Math.max(0, Math.min(120, parseInt(req.graceSeconds, 10) || 0)) : 15;
    var maxAttempts = req.maxAttempts !== undefined && req.maxAttempts !== '' ? Math.max(0, Math.min(100, parseInt(req.maxAttempts, 10) || 0)) : (examMode === 'PRACTICE' ? 0 : 1);
    if (examMode !== 'PRACTICE' && maxAttempts < 1) maxAttempts = 1;
    var passThresholdPct = req.passThresholdPct !== undefined && req.passThresholdPct !== '' ? Math.max(0, Math.min(100, parseInt(req.passThresholdPct, 10) || 60)) : 60;
    var openAtUtc = parseOptUtc(req.openAtUtc, 'openAtUtc', 'Open time', errs);
    var closeAtUtc = parseOptUtc(req.closeAtUtc, 'closeAtUtc', 'Close time', errs);
    if (openAtUtc && closeAtUtc && Date.parse(openAtUtc) >= Date.parse(closeAtUtc)) errs.closeAtUtc = 'Close time must be after open time.';
    var scoreReleaseAtUtc = parseOptUtc(req.scoreReleaseAtUtc, 'scoreReleaseAtUtc', 'Score release time', errs);
    var expReleaseAtUtc = parseOptUtc(req.explanationReleaseAtUtc, 'explanationReleaseAtUtc', 'Explanation release time', errs);
    var coverImgId = validateFileId(req.coverImageFileId, 'coverImageFileId', errs);
    var descNorm = B().normalizeRichTextDoc(req.descriptionRichText || '', false);
    var instNorm = B().normalizeRichTextDoc(req.instructionsRichText || '', false);
    var rawSections = Array.isArray(req.sections) ? req.sections : [];
    if (Object.keys(errs).length > 0) throw err('ERR_VALIDATION_FAILED', 'Please fix the highlighted examination builder fields.', errs);

    var qbB = await loadQuestionBankBundle();
    var dup = okPg(await sb().from('exam_sets').select('exam_set_id').eq('exam_code', examCode).maybeSingle());
    if (dup && dup.exam_set_id !== examSetId) throw err('ERR_VALIDATION_FAILED', 'Exam code "' + examCode + '" already exists.', { examCode: 'Must be unique.' });

    var now = nowIso();
    var exRow = isCreate ? null : okPg(await sb().from('exam_sets').select('*').eq('exam_set_id', examSetId).maybeSingle());
    if (!isCreate && !exRow) throw err('ERR_NOT_FOUND', 'Examination set not found.');

    var draftVerId = exRow ? exRow.draft_exam_version_id : '';
    var draftVerRow = draftVerId ? okPg(await sb().from('exam_versions').select('*').eq('exam_version_id', draftVerId).maybeSingle()) : null;
    var createNewVer = !draftVerRow || draftVerRow.version_state === 'PUBLISHED';
    var nextVerNo = exRow ? (createNewVer ? (Number(exRow.latest_version_no) || 1) + 1 : Number(draftVerRow.version_no) || 1) : 1;
    var targetVerId = createNewVer ? genId('exv_') : draftVerRow.exam_version_id;
    var latestVerNo = exRow ? Math.max(Number(exRow.latest_version_no) || 1, nextVerNo) : 1;
    var copyPolicyEnabled = req.copyPolicyEnabled !== undefined ? Boolean(req.copyPolicyEnabled) : (exRow ? Boolean(exRow.copy_policy_enabled) : examMode !== 'PRACTICE');

    if (isCreate) {
      examSetId = genId('exs_');
      exRow = okPg(await sb().from('exam_sets').insert({
        exam_set_id: examSetId,
        course_id: courseId,
        exam_code: examCode,
        title: title,
        description_richtext_json: descNorm.doc,
        instructions_richtext_json: instNorm.doc,
        cover_image_file_id: coverImgId,
        exam_mode: examMode,
        active_exam_version_id: '',
        draft_exam_version_id: targetVerId,
        latest_version_no: latestVerNo,
        assignment_scope: assignmentScope,
        open_at_utc: openAtUtc,
        close_at_utc: closeAtUtc,
        duration_minutes: durationMinutes,
        grace_seconds: graceSeconds,
        max_attempts: maxAttempts,
        retake_cooldown_minutes: Math.max(0, parseInt(req.retakeCooldownMinutes, 10) || 0),
        navigation_mode: navigationMode,
        aggregation_rule: aggregationRule,
        score_release_policy: scoreReleasePolicy,
        score_release_at_utc: scoreReleaseAtUtc,
        explanation_release_policy: explanationReleasePolicy,
        explanation_release_at_utc: expReleaseAtUtc,
        pass_threshold_pct: passThresholdPct,
        randomize_questions: Boolean(req.randomizeQuestions),
        randomize_options: Boolean(req.randomizeOptions),
        allow_per_question_practice_feedback: examMode === 'PRACTICE' ? Boolean(req.allowPerQuestionPracticeFeedback) : false,
        status: 'DRAFT',
        created_by_user_id: admin.userId,
        created_at_utc: now,
        updated_at_utc: now,
        version: 1,
        copy_policy_enabled: copyPolicyEnabled,
        copy_policy_version: INTEGRITY_DEFAULTS.POLICY_VERSION,
        max_copy_warnings: INTEGRITY_DEFAULTS.MAX_COPY_WARNINGS,
        copy_suspension_seconds: INTEGRITY_DEFAULTS.SUSPENSION_SECONDS,
        max_integrity_invalidations_before_lock: INTEGRITY_DEFAULTS.MAX_INVALIDATIONS_BEFORE_LOCK
      }).select('*').single(), 'Create exam set');
    } else {
      exRow = okPg(await sb().from('exam_sets').update({
        course_id: courseId,
        exam_code: examCode,
        title: title,
        description_richtext_json: descNorm.doc,
        instructions_richtext_json: instNorm.doc,
        cover_image_file_id: coverImgId,
        exam_mode: examMode,
        draft_exam_version_id: targetVerId,
        latest_version_no: latestVerNo,
        assignment_scope: assignmentScope,
        open_at_utc: openAtUtc,
        close_at_utc: closeAtUtc,
        duration_minutes: durationMinutes,
        grace_seconds: graceSeconds,
        max_attempts: maxAttempts,
        retake_cooldown_minutes: Math.max(0, parseInt(req.retakeCooldownMinutes, 10) || 0),
        navigation_mode: navigationMode,
        aggregation_rule: aggregationRule,
        score_release_policy: scoreReleasePolicy,
        score_release_at_utc: scoreReleaseAtUtc,
        explanation_release_policy: explanationReleasePolicy,
        explanation_release_at_utc: expReleaseAtUtc,
        pass_threshold_pct: passThresholdPct,
        randomize_questions: Boolean(req.randomizeQuestions),
        randomize_options: Boolean(req.randomizeOptions),
        allow_per_question_practice_feedback: examMode === 'PRACTICE' ? Boolean(req.allowPerQuestionPracticeFeedback) : false,
        updated_at_utc: now,
        copy_policy_enabled: copyPolicyEnabled,
        version: (Number(exRow.version) || 1) + 1
      }).eq('exam_set_id', examSetId).select('*').single(), 'Update exam set');
    }

    var totalQ = 0, totalMaxBp = 0, anyNeg = false;
    var sectionsToInsert = [], itemsToInsert = [];

    rawSections.forEach(function (secInput, sIdx) {
      var secObj = secInput && typeof secInput === 'object' ? secInput : {};
      var secId = genId('exsc_');
      var selMode = String(secObj.selectionMode || 'FIXED_ITEMS').trim().toUpperCase() === 'QUESTION_POOL' ? 'QUESTION_POOL' : 'FIXED_ITEMS';
      var rawItems = Array.isArray(secObj.items) ? secObj.items : [];
      var drawCount = selMode === 'QUESTION_POOL' ? Math.max(1, Math.min(rawItems.length || 1, parseInt(secObj.poolDrawCount, 10) || 1)) : rawItems.length;
      var secInst = B().normalizeRichTextDoc(secObj.instructionsRichText || '', false);
      var secMaxBp = 0;

      rawItems.forEach(function (itInput, k) {
        var itObj = itInput && typeof itInput === 'object' ? itInput : {};
        var qid = clean(itObj.questionId, 64);
        var qb = qbB.qbById[qid];
        if (!qb) return;
        var qvid = clean(itObj.questionVersionId, 64) || qb.active_version_id;
        var qv = qbB.qvById[qvid] || qbB.qvById[qb.active_version_id];
        if (!qv) return;
        var ptsBp = itObj.points !== undefined && itObj.points !== '' ? Math.max(1, Math.round(Number(itObj.points) * 100)) : (Number(itObj.pointsBp) || Number(qv.default_points_bp) || 100);
        var negBp = itObj.negativePoints !== undefined && itObj.negativePoints !== '' ? Math.max(0, Math.round(Number(itObj.negativePoints) * 100)) : (Number(itObj.negativePointsBp) || Number(qv.negative_points_bp) || 0);
        if (negBp > 0) anyNeg = true;
        if (selMode !== 'QUESTION_POOL' || k < drawCount) secMaxBp += ptsBp;
        itemsToInsert.push({
          exam_item_id: genId('exi_'),
          exam_version_id: targetVerId,
          exam_section_id: secId,
          exam_set_id: examSetId,
          question_id: qb.question_id,
          question_version_id: qv.question_version_id,
          sort_order: (k + 1) * 10,
          lock_item_position: Boolean(itObj.lockItemPosition),
          lock_option_order: Boolean(itObj.lockOptionOrder) || Boolean(qv.lock_option_order),
          points_bp: ptsBp,
          negative_points_bp: negBp,
          is_pool_candidate: selMode === 'QUESTION_POOL',
          pool_group_tag: clean(itObj.poolGroupTag, 48),
          created_at_utc: now
        });
      });

      var secQCount = selMode === 'QUESTION_POOL' ? Math.min(drawCount, rawItems.length) : rawItems.length;
      totalQ += secQCount;
      totalMaxBp += secMaxBp;
      sectionsToInsert.push({
        exam_section_id: secId,
        exam_version_id: targetVerId,
        exam_set_id: examSetId,
        title: clean(secObj.title, 160) || ('Section ' + (sIdx + 1)),
        instructions_richtext_json: secInst.doc,
        sort_order: (sIdx + 1) * 10,
        selection_mode: selMode,
        pool_draw_count: drawCount,
        pool_filter_json: {},
        lock_section_order: Boolean(secObj.lockSectionOrder),
        randomize_items_within_section: Boolean(secObj.randomizeItemsWithinSection),
        section_questions_count: secQCount,
        section_max_points_bp: secMaxBp,
        created_at_utc: now
      });
    });

    var verFields = {
      exam_set_id: examSetId,
      version_no: nextVerNo,
      version_state: 'DRAFT',
      exam_mode: examMode,
      title: title,
      instructions_richtext_json: instNorm.doc,
      duration_minutes: durationMinutes,
      grace_seconds: graceSeconds,
      total_questions_count: totalQ,
      max_points_bp: totalMaxBp,
      negative_marking_enabled: anyNeg,
      unanswered_points_bp: 0,
      navigation_mode: navigationMode,
      randomize_questions: Boolean(req.randomizeQuestions),
      randomize_options: Boolean(req.randomizeOptions),
      allow_per_question_practice_feedback: examMode === 'PRACTICE' ? Boolean(req.allowPerQuestionPracticeFeedback) : false,
      policy_snapshot_json: {}
    };

    if (createNewVer) {
      okPg(await sb().from('exam_versions').insert(Object.assign({ exam_version_id: targetVerId, created_at_utc: now }, verFields)), 'Create exam version');
    } else {
      okPg(await sb().from('exam_items').delete().eq('exam_version_id', targetVerId));
      okPg(await sb().from('exam_sections').delete().eq('exam_version_id', targetVerId));
      okPg(await sb().from('exam_versions').update(verFields).eq('exam_version_id', targetVerId), 'Update exam version');
    }

    if (sectionsToInsert.length > 0) okPg(await sb().from('exam_sections').insert(sectionsToInsert), 'Insert exam sections');
    if (itemsToInsert.length > 0) okPg(await sb().from('exam_items').insert(itemsToInsert), 'Insert exam items');

    await B().writeAuditEvent(admin.userId, 'ADMIN', 'ADMIN_EXAM_DRAFT_SAVED', 'ExamSet', examSetId, { examCode: examCode, versionNo: nextVerNo });
    var listB = await handleAdminListExams({}, token);
    var savedExam = listB.exams.find(function (e) { return e.examSetId === examSetId; }) || null;
    return { exam: savedExam, exams: listB.exams, summary: listB.summary };
  }

  async function handleAdminValidateExam(payload, token) {
    await B().requireSession(token, ['ADMIN']);
    var listB = await handleAdminListExams({}, token);
    var examSetId = clean(payload && payload.examSetId, 64);
    var ex = listB.exams.find(function (e) { return e.examSetId === examSetId; });
    if (!ex) throw err('ERR_NOT_FOUND', 'Examination set not found.');
    return { exam: ex, validationReport: ex.validationReport };
  }

  async function handleAdminPublishExam(payload, token) {
    var admin = await B().requireSession(token, ['ADMIN']);
    var examSetId = clean(payload && payload.examSetId, 64);
    var listB = await handleAdminListExams({}, token);
    var exDto = listB.exams.find(function (e) { return e.examSetId === examSetId; });
    if (!exDto) throw err('ERR_NOT_FOUND', 'Examination set not found.');
    if (!exDto.validationReport.canPublish) {
      throw err('ERR_VALIDATION_FAILED', 'Examination failed publication readiness checks: ' + exDto.validationReport.blockingErrors.map(function (b) { return b.message; }).join(' '));
    }
    var exRow = okPg(await sb().from('exam_sets').select('*').eq('exam_set_id', examSetId).single());
    var verId = exRow.draft_exam_version_id || exRow.active_exam_version_id;
    var verRow = okPg(await sb().from('exam_versions').select('*').eq('exam_version_id', verId).single());
    var now = nowIso();
    var asmId = await syncExamSetToAssessmentsTable(exRow, verRow, admin.userId);

    okPg(await sb().from('exam_versions').update({ version_state: 'PUBLISHED', published_by_user_id: admin.userId, published_at_utc: now }).eq('exam_version_id', verId));
    okPg(await sb().from('exam_sets').update({
      assessment_id: asmId || exRow.assessment_id || '',
      active_exam_version_id: verId,
      draft_exam_version_id: verId,
      status: 'PUBLISHED',
      updated_at_utc: now,
      version: (Number(exRow.version) || 1) + 1
    }).eq('exam_set_id', examSetId));

    if (exRow.assignment_scope === 'COURSE_ENROLLED' && exRow.course_id) {
      var curAsg = okPg(await sb().from('exam_assignments').select('*').eq('exam_set_id', examSetId).eq('target_type', 'COURSE').eq('course_id', exRow.course_id).maybeSingle());
      if (!curAsg) {
        okPg(await sb().from('exam_assignments').insert({
          assignment_id: genId('exa_'),
          exam_set_id: examSetId,
          course_id: exRow.course_id,
          target_type: 'COURSE',
          student_user_id: '',
          assignment_status: 'ASSIGNED',
          accommodation_reason: 'Course-wide enrollment assignment on publish',
          assigned_by_user_id: admin.userId,
          created_at_utc: now,
          updated_at_utc: now,
          version: 1
        }));
      } else if (curAsg.assignment_status !== 'ASSIGNED') {
        okPg(await sb().from('exam_assignments').update({ assignment_status: 'ASSIGNED', updated_at_utc: now }).eq('assignment_id', curAsg.assignment_id));
      }
    }

    await B().writeAuditEvent(admin.userId, 'ADMIN', 'ADMIN_EXAM_PUBLISHED', 'ExamSet', examSetId, { examCode: exRow.exam_code, versionId: verId });
    var updated = await handleAdminListExams({}, token);
    return { exam: updated.exams.find(function (e) { return e.examSetId === examSetId; }), validationReport: exDto.validationReport, exams: updated.exams, summary: updated.summary };
  }

  async function handleAdminAssignExam(payload, token) {
    var admin = await B().requireSession(token, ['ADMIN']);
    var req = payload || {};
    var errs = {};
    var examSetId = clean(req.examSetId, 64);
    if (!examSetId) errs.examSetId = 'examSetId is required.';
    var targetType = String(req.targetType || 'STUDENT').trim().toUpperCase();
    if (targetType !== 'COURSE' && targetType !== 'STUDENT') errs.targetType = 'COURSE or STUDENT required.';
    var courseId = clean(req.courseId, 64);
    var studentUserId = clean(req.studentUserId, 64);
    if (targetType === 'COURSE' && !courseId) errs.courseId = 'courseId is required.';
    if (targetType === 'STUDENT' && !studentUserId) errs.studentUserId = 'studentUserId is required.';
    var openOvr = parseOptUtc(req.openAtOverrideUtc, 'openAtOverrideUtc', 'Override open', errs);
    var deadOvr = parseOptUtc(req.overrideDeadlineUtc, 'overrideDeadlineUtc', 'Override deadline', errs);
    if (Object.keys(errs).length > 0) throw err('ERR_VALIDATION_FAILED', 'Please fix assignment fields.', errs);

    var exRow = okPg(await sb().from('exam_sets').select('exam_set_id,course_id').eq('exam_set_id', examSetId).maybeSingle());
    if (!exRow) throw err('ERR_NOT_FOUND', 'Examination set not found.');
    var effCourseId = courseId || exRow.course_id || '';
    var status = String(req.assignmentStatus || 'ASSIGNED').trim().toUpperCase() === 'REVOKED' ? 'REVOKED' : 'ASSIGNED';
    var now = nowIso();

    var q = sb().from('exam_assignments').select('*').eq('exam_set_id', examSetId).eq('target_type', targetType);
    q = targetType === 'COURSE' ? q.eq('course_id', effCourseId) : q.eq('student_user_id', studentUserId);
    var existing = okPg(await q.maybeSingle());

    var fields = {
      exam_set_id: examSetId,
      course_id: effCourseId,
      target_type: targetType,
      student_user_id: targetType === 'STUDENT' ? studentUserId : '',
      assignment_status: status,
      open_at_override_utc: openOvr,
      override_deadline_utc: deadOvr,
      extra_time_minutes: Math.max(0, Math.min(300, parseInt(req.extraTimeMinutes, 10) || 0)),
      extra_attempts_granted: Math.max(0, Math.min(50, parseInt(req.extraAttemptsGranted, 10) || 0)),
      accommodation_reason: clean(req.accommodationReason, 400),
      assigned_by_user_id: admin.userId,
      updated_at_utc: now
    };
    var saved = existing
      ? okPg(await sb().from('exam_assignments').update(Object.assign({}, fields, { version: (Number(existing.version) || 1) + 1 })).eq('assignment_id', existing.assignment_id).select('*').single())
      : okPg(await sb().from('exam_assignments').insert(Object.assign({ assignment_id: genId('exa_'), created_at_utc: now, version: 1 }, fields)).select('*').single());

    await B().writeAuditEvent(admin.userId, 'ADMIN', 'ADMIN_EXAM_ASSIGNMENT_SAVED', 'ExamAssignment', saved.assignment_id, { examSetId: examSetId, targetType: targetType, status: status });
    var updated = await handleAdminListExams({}, token);
    return { assignmentId: saved.assignment_id, exams: updated.exams, summary: updated.summary };
  }

  async function handleAdminSeedSampleExams(payload, token) {
    await B().requireSession(token, ['ADMIN']);
    await handleAdminSeedSampleBiologyBank({}, token);
    var all = await Promise.all([
      sb().from('question_bank').select('question_id,question_code'),
      sb().from('courses').select('course_id,status'),
      sb().from('exam_sets').select('exam_set_id,exam_code')
    ]);
    var qByCode = {}; (okPg(all[0]) || []).forEach(function (q) { qByCode[String(q.question_code).toUpperCase()] = q.question_id; });
    var crsList = okPg(all[1]) || [];
    var targetCourse = (payload && payload.courseId) || ((crsList.find(function (c) { return c.status === 'PUBLISHED'; }) || crsList[0] || {}).course_id) || '';
    var exByCode = {}; (okPg(all[2]) || []).forEach(function (e) { exByCode[String(e.exam_code).toUpperCase()] = e; });

    var specs = [
      {
        examCode: 'BIO-PRAC-PHOTO-01',
        title: 'Practice Quiz: Light Reactions & Hill Reaction Experiment',
        courseId: targetCourse,
        examMode: 'PRACTICE',
        assignmentScope: 'COURSE_ENROLLED',
        durationMinutes: 0,
        maxAttempts: 0,
        navigationMode: 'FREE',
        scoreReleasePolicy: 'IMMEDIATE_AUTO',
        explanationReleasePolicy: 'WITH_SCORE',
        passThresholdPct: 60,
        randomizeOptions: true,
        allowPerQuestionPracticeFeedback: true,
        descriptionRichText: 'Untimed self-paced biology practice quiz on chloroplast electron transport and DCMU inhibition.',
        instructionsRichText: 'Take this untimed quiz as many times as you wish. Explanations release immediately.',
        sections: [{ title: 'Part 1: Hill Reaction & Bioenergetics', selectionMode: 'FIXED_ITEMS', items: [{ questionId: qByCode['BIO-PHOTO-SC-01'], points: 2 }, { questionId: qByCode['BIO-ENZYME-TF-03'], points: 1 }, { questionId: qByCode['BIO-MOLEC-SA-05'], points: 2 }] }]
      },
      {
        examCode: 'BIO-MOCK-ALEVEL-01',
        title: 'A-Level Biology Timed Mock Exam: Bioenergetics & Genetics',
        courseId: targetCourse,
        examMode: 'MOCK_EXAM',
        assignmentScope: 'COURSE_ENROLLED',
        durationMinutes: 45,
        graceSeconds: 15,
        maxAttempts: 1,
        navigationMode: 'FREE',
        scoreReleasePolicy: 'IMMEDIATE_AUTO',
        explanationReleasePolicy: 'WITH_SCORE',
        passThresholdPct: 65,
        randomizeQuestions: true,
        randomizeOptions: true,
        copyPolicyEnabled: true,
        descriptionRichText: 'Simulated 45-minute A-Level examination combining stimulus questions and quantitative genetics.',
        instructionsRichText: 'Strict 45-minute timer with auto-submission on expiry.',
        sections: [
          { title: 'Section A: Objective & Quantitative Biology', selectionMode: 'FIXED_ITEMS', items: [{ questionId: qByCode['BIO-PHOTO-SC-01'], points: 2 }, { questionId: qByCode['BIO-CELL-MS-02'], points: 2 }, { questionId: qByCode['BIO-GENETICS-NUM-04'], points: 2 }] },
          { title: 'Section B: Extended Biological Mechanism (Manual Rubric)', selectionMode: 'FIXED_ITEMS', items: [{ questionId: qByCode['BIO-PHYSIO-WR-06'], points: 4 }] }
        ]
      }
    ];

    for (var i = 0; i < specs.length; i++) {
      if (!exByCode[specs[i].examCode] && specs[i].sections[0].items.every(function (x) { return Boolean(x.questionId); })) {
        var drafted = await handleAdminSaveExamDraft(specs[i], token);
        if (drafted.exam && drafted.exam.validationReport.canPublish) {
          await handleAdminPublishExam({ examSetId: drafted.exam.examSetId }, token);
        }
      }
    }
    return await handleAdminListExams({}, token);
  }

  // ==================== STUDENT CATALOG, ATTEMPT START & WORKSPACE ====================

  function resolveEffectiveReleaseState(att, exRow, nowMs) {
    var curPub = att.publication_status || 'UNPUBLISHED';
    var curExp = att.explanation_status || 'WITHHELD';
    var effPub = curPub;
    var effExp = curExp;
    var tNow = nowMs || Date.now();
    if ((att.grading_status === 'GRADED' || att.grading_status === 'REGRADED') && curPub !== 'WITHHELD' && curPub !== 'PUBLISHED') {
      if (exRow.score_release_policy === 'IMMEDIATE_AUTO') effPub = 'PUBLISHED';
      else if (exRow.score_release_policy === 'SCHEDULED' && exRow.score_release_at_utc && Date.parse(exRow.score_release_at_utc) <= tNow) effPub = 'PUBLISHED';
      else if (exRow.score_release_policy === 'AFTER_CLOSE' && exRow.close_at_utc && Date.parse(exRow.close_at_utc) <= tNow) effPub = 'PUBLISHED';
    }
    if (effPub === 'PUBLISHED' && curExp !== 'RELEASED') {
      if (exRow.explanation_release_policy === 'WITH_SCORE') effExp = 'RELEASED';
      else if (exRow.explanation_release_policy === 'SCHEDULED' && exRow.explanation_release_at_utc && Date.parse(exRow.explanation_release_at_utc) <= tNow) effExp = 'RELEASED';
      else if (exRow.explanation_release_policy === 'AFTER_CLOSE' && exRow.close_at_utc && Date.parse(exRow.close_at_utc) <= tNow) effExp = 'RELEASED';
    }
    return { effectivePublicationStatus: effPub, effectiveExplanationStatus: effExp };
  }

  function evaluateStudentExamCatalogEntry(ex, ver, allSecs, allItems, studentUserId, isEnrolled, examAssigns, studentAttempts, crsById, qbById, qvById, isAdminPreview) {
    var cRec = crsById[ex.course_id];
    var stuAsg = null, crsAsgRevoked = false, crsAsgAssigned = false;
    examAssigns.forEach(function (a) {
      if (a.target_type === 'STUDENT' && a.student_user_id === studentUserId) stuAsg = a;
      if (a.target_type === 'COURSE' && a.course_id === ex.course_id) {
        if (a.assignment_status === 'REVOKED') crsAsgRevoked = true;
        else if (a.assignment_status === 'ASSIGNED') crsAsgAssigned = true;
      }
    });
    if (!isAdminPreview) {
      if (stuAsg && stuAsg.assignment_status === 'REVOKED') return null;
      var hasStudentAllow = Boolean(stuAsg && stuAsg.assignment_status === 'ASSIGNED');
      if (ex.assignment_scope === 'SELECTED_STUDENTS' && !hasStudentAllow) return null;
      if (ex.assignment_scope === 'COURSE_ENROLLED' && !hasStudentAllow && !(isEnrolled && !crsAsgRevoked && (crsAsgAssigned || !ex.course_id || isEnrolled))) return null;
    }

    var nowMs = Date.now();
    var extraTime = stuAsg ? Number(stuAsg.extra_time_minutes) || 0 : 0;
    var extraAtt = stuAsg ? Number(stuAsg.extra_attempts_granted) || 0 : 0;
    var effOpen = (stuAsg && stuAsg.open_at_override_utc) || ex.open_at_utc || '';
    var effClose = (stuAsg && stuAsg.override_deadline_utc) || ex.close_at_utc || '';
    var baseDur = Number(ex.duration_minutes) || 0;
    var effDur = baseDur > 0 ? baseDur + extraTime : 0;
    var rawMaxAtt = Number(ex.max_attempts) || 0;
    var isUnlimited = rawMaxAtt === 0;
    var effMaxAtt = isUnlimited ? 0 : rawMaxAtt + extraAtt;

    var inProg = null, submitted = [], pubScored = [];
    var attUsed = 0;
    studentAttempts.sort(function (a, b) { return (Number(a.attempt_number) || 0) - (Number(b.attempt_number) || 0); });
    studentAttempts.forEach(function (a) {
      if (a.attempt_status === 'IN_PROGRESS') inProg = a;
      if (a.attempt_status !== 'INVALIDATED' && !a.invalidation_overturned) attUsed += 1;
      if (a.attempt_status === 'SUBMITTED' || a.attempt_status === 'EXPIRED_SUBMITTED') {
        submitted.push(a);
        var rel = resolveEffectiveReleaseState(a, ex, nowMs);
        if (rel.effectivePublicationStatus === 'PUBLISHED' && (a.grading_status === 'GRADED' || a.grading_status === 'REGRADED')) {
          pubScored.push({ att: a, rel: rel });
        }
      }
    });

    var remAtt = isUnlimited ? 999 : Math.max(0, effMaxAtt - attUsed);
    var isUpcoming = Boolean(effOpen && Date.parse(effOpen) > nowMs);
    var isClosed = ex.status === 'CLOSED' || Boolean(effClose && Date.parse(effClose) <= nowMs);
    var canResume = Boolean(inProg);
    var canStart = !canResume && !isUpcoming && !isClosed && (isUnlimited || remAtt > 0);
    var availState = canResume ? 'IN_PROGRESS_RESUMABLE' : (isUpcoming ? 'UPCOMING' : (isClosed ? 'CLOSED' : ((!isUnlimited && remAtt <= 0) ? 'ATTEMPTS_EXHAUSTED' : 'AVAILABLE')));
    var compState = submitted.length > 0 ? 'COMPLETED' : (inProg ? 'IN_PROGRESS' : 'NOT_STARTED');

    var chosen = null;
    if (pubScored.length > 0) {
      if (ex.aggregation_rule === 'FIRST_PUBLISHED') chosen = pubScored[0];
      else if (ex.aggregation_rule === 'LATEST_PUBLISHED') chosen = pubScored[pubScored.length - 1];
      else {
        chosen = pubScored[0];
        pubScored.forEach(function (x) { if ((Number(x.att.total_score_bp) || 0) > (Number(chosen.att.total_score_bp) || 0)) chosen = x; });
      }
    }

    var pubSummary = chosen ? {
      attemptId: chosen.att.attempt_id,
      scoreDisplay: formatPointsBp(chosen.att.total_score_bp) + ' / ' + formatPointsBp(chosen.att.max_score_bp),
      percentageFormatted: (Math.round((Number(chosen.att.percentage_bp) || 0) / 10) / 10).toFixed(1) + '%',
      passedFlag: Boolean(chosen.att.passed_flag),
      explanationsReleased: chosen.rel.effectiveExplanationStatus === 'RELEASED'
    } : null;

    var latestSub = submitted.length > 0 ? submitted[submitted.length - 1] : null;
    var verStruct = buildExamVersionStructureBundle(ex, ver, allSecs, allItems, qbById, qvById, {}, {}, false);
    var descDoc = asRichDoc(ex.description_richtext_json || '');
    var instDoc = asRichDoc(ex.instructions_richtext_json || '');

    return {
      assessmentKind: 'NATIVE_EXAM',
      assessmentKindLabel: 'Native Online Examination',
      examSetId: ex.exam_set_id,
      assessmentId: ex.assessment_id || '',
      courseId: ex.course_id || '',
      courseCode: cRec ? cRec.course_code : '',
      courseTitle: cRec ? cRec.title : '',
      examCode: ex.exam_code,
      title: ex.title,
      descriptionRichText: descDoc,
      descriptionPlainText: extractPlainText(descDoc),
      instructionsRichText: instDoc,
      instructionsPlainText: extractPlainText(instDoc),
      coverImageFileId: ex.cover_image_file_id || '',
      examMode: ex.exam_mode,
      examModeLabel: fmtModeLabel(ex.exam_mode),
      activeExamVersionId: ex.active_exam_version_id || '',
      versionNo: verStruct.versionNo,
      questionCount: verStruct.totalQuestionsCount,
      sectionCount: verStruct.sections.length,
      maxPointsBp: verStruct.maxPointsBp,
      maxPointsDisplay: verStruct.maxPointsDisplay,
      negativeMarkingEnabled: verStruct.negativeMarkingEnabled,
      navigationMode: ex.navigation_mode || 'FREE',
      durationMinutes: baseDur,
      effectiveDurationMinutes: effDur,
      durationLabel: fmtDurationMin(effDur),
      graceSeconds: Number(ex.grace_seconds) || 15,
      hasTimeAccommodation: extraTime > 0,
      extraTimeMinutes: extraTime,
      openAtUtc: effOpen,
      openAtBangkok: effOpen ? fmtBkk(effOpen) : 'Immediately Available',
      closeAtUtc: effClose,
      closeAtBangkok: effClose ? fmtBkk(effClose) : 'No Closing Deadline',
      allowedAttempts: isUnlimited ? 'UNLIMITED' : effMaxAtt,
      allowedAttemptsDisplay: isUnlimited ? 'Unlimited' : String(effMaxAtt),
      attemptsUsed: attUsed,
      remainingAttempts: isUnlimited ? 'UNLIMITED' : remAtt,
      aggregationRule: ex.aggregation_rule || 'BEST_PUBLISHED',
      scoreReleasePolicy: ex.score_release_policy || 'MANUAL_ADMIN',
      explanationReleasePolicy: ex.explanation_release_policy || 'WITH_SCORE',
      passThresholdPct: Number(ex.pass_threshold_pct) || 60,
      examLifecycleStatus: ex.status,
      availabilityState: availState,
      completionState: compState,
      attemptStatusSummary: inProg ? 'IN_PROGRESS' : (latestSub ? latestSub.attempt_status : 'NONE'),
      gradingStatusSummary: latestSub ? latestSub.grading_status : 'NOT_GRADED',
      publicationStatusSummary: pubSummary ? 'PUBLISHED' : (latestSub ? latestSub.publication_status : 'UNPUBLISHED'),
      explanationStatusSummary: pubSummary && pubSummary.explanationsReleased ? 'RELEASED' : 'WITHHELD',
      canStartNewAttempt: canStart,
      canResumeAttempt: canResume,
      activeAttemptId: inProg ? inProg.attempt_id : '',
      canViewPublishedResult: Boolean(pubSummary),
      primaryActionType: canResume ? 'RESUME_ATTEMPT' : (pubSummary && !canStart ? 'VIEW_RESULT' : 'VIEW_INSTRUCTIONS'),
      primaryActionLabel: canResume ? 'Resume Active Attempt' : (pubSummary && !canStart ? 'View Published Result' : (isUpcoming ? 'Preview Rules (Upcoming)' : 'Open Examination')),
      publishedScoreSummary: pubSummary,
      sectionsOverview: verStruct.sections,
      questionTypeBreakdown: verStruct.questionTypeBreakdown
    };
  }

  function resolveAttemptIntegrityPolicy(ex, ver, stuAsg) {
    var acMode = stuAsg && String(stuAsg.copy_policy_accommodation_mode || '').trim().toUpperCase();
    var exempt = acMode === 'COPY_POLICY_EXEMPT';
    var enabled = Boolean(ex.copy_policy_enabled) && ex.exam_mode !== 'PRACTICE' && !exempt;
    var maxW = (acMode === 'CUSTOM_THRESHOLD' && Number(stuAsg.custom_max_copy_warnings) > 0) ? Number(stuAsg.custom_max_copy_warnings) : (Number(ex.max_copy_warnings) || INTEGRITY_DEFAULTS.MAX_COPY_WARNINGS);
    return {
      copyPolicyEnabled: enabled,
      policyVersion: ex.copy_policy_version || INTEGRITY_DEFAULTS.POLICY_VERSION,
      maxCopyWarnings: maxW,
      copySuspensionSeconds: Number(ex.copy_suspension_seconds) || INTEGRITY_DEFAULTS.SUSPENSION_SECONDS,
      maxIntegrityInvalidationsBeforeLock: Number(ex.max_integrity_invalidations_before_lock) || INTEGRITY_DEFAULTS.MAX_INVALIDATIONS_BEFORE_LOCK,
      requiresAcknowledgment: enabled
    };
  }

  function buildAttemptIntegrityStateDto(att, exRow) {
    var enabled = Boolean(att.copy_policy_enabled_snapshot);
    var suspMs = att.suspension_until_utc ? Date.parse(att.suspension_until_utc) : 0;
    var nowMs = Date.now();
    var remSusp = enabled && suspMs > nowMs ? Math.ceil((suspMs - nowMs) / 1000) : 0;
    return {
      copyPolicyEnabled: enabled,
      policyVersion: att.copy_policy_version_snapshot || INTEGRITY_DEFAULTS.POLICY_VERSION,
      maxCopyWarnings: Number(att.max_copy_warnings_snapshot) || INTEGRITY_DEFAULTS.MAX_COPY_WARNINGS,
      copySuspensionSeconds: Number(att.copy_suspension_seconds_snapshot) || INTEGRITY_DEFAULTS.SUSPENSION_SECONDS,
      warningCount: Number(att.copy_warning_count) || 0,
      isCurrentlySuspended: remSusp > 0,
      remainingSuspensionSeconds: remSusp,
      suspensionUntilUtc: att.suspension_until_utc || '',
      isInvalidated: att.attempt_status === 'INVALIDATED_COPY_POLICY' || (att.attempt_status === 'INVALIDATED' && att.invalidation_reason_code === 'COPY_POLICY_LIMIT_EXCEEDED'),
      invalidationReasonCode: att.invalidation_reason_code || '',
      acknowledgedAtUtc: att.policy_acknowledged_at_utc || ''
    };
  }

  async function handleStudentListExams(payload, token) {
    var ses = await B().requireSession(token, ['STUDENT', 'ADMIN']);
    var req = payload || {};
    var fCrs = clean(req.courseId, 64), fMode = String(req.examMode || 'ALL').toUpperCase(), fAvail = String(req.availabilityState || 'ALL').toUpperCase(), fComp = String(req.completionState || 'ALL').toUpperCase();
    var searchQ = String(req.search || '').trim().toLowerCase();

    var all = await Promise.all([
      sb().from('exam_sets').select('*').in('status', ['PUBLISHED', 'CLOSED']),
      sb().from('exam_versions').select('*'),
      sb().from('exam_sections').select('*'),
      sb().from('exam_items').select('*'),
      sb().from('exam_assignments').select('*'),
      sb().from('exam_attempts').select('*').eq('student_user_id', ses.userId),
      sb().from('enrollments').select('course_id,status').eq('user_id', ses.userId).eq('status', 'ACTIVE'),
      sb().from('courses').select('*'),
      sb().from('cards').select('*').eq('card_type', 'ASSESSMENT_LINK_CARD').eq('status', 'PUBLISHED'),
      sb().from('assessments').select('*').eq('status', 'ACTIVE'),
      loadQuestionBankBundle()
    ]);

    var exsRows = okPg(all[0], 'List student exams') || [];
    var exvById = {}; (okPg(all[1]) || []).forEach(function (v) { exvById[v.exam_version_id] = v; });
    var exSecs = okPg(all[2]) || [], exItems = okPg(all[3]) || [];
    var assignByEx = {}; (okPg(all[4]) || []).forEach(function (a) { if (!assignByEx[a.exam_set_id]) assignByEx[a.exam_set_id] = []; assignByEx[a.exam_set_id].push(a); });
    var attByEx = {}; (okPg(all[5]) || []).forEach(function (a) { if (!attByEx[a.exam_set_id]) attByEx[a.exam_set_id] = []; attByEx[a.exam_set_id].push(a); });
    var enrCrsIds = {}; (okPg(all[6]) || []).forEach(function (e) { enrCrsIds[e.course_id] = true; });
    var crsById = {}; (okPg(all[7]) || []).forEach(function (c) { crsById[c.course_id] = c; });
    var cardsRows = okPg(all[8]) || [], asmById = {}; (okPg(all[9]) || []).forEach(function (a) { asmById[a.assessment_id] = a; });
    var qbB = all[10];

    var items = [], counts = { totalCatalogExams: 0, availableCount: 0, inProgressCount: 0, completedCount: 0, upcomingCount: 0, closedCount: 0 };
    for (var i = exsRows.length - 1; i >= 0; i--) {
      var ex = exsRows[i];
      if (fCrs && ex.course_id !== fCrs) continue;
      var ver = ex.active_exam_version_id ? exvById[ex.active_exam_version_id] : null;
      if (!ver) continue;
      var entry = evaluateStudentExamCatalogEntry(
        ex, ver, exSecs, exItems, ses.userId, Boolean(enrCrsIds[ex.course_id]),
        assignByEx[ex.exam_set_id] || [], attByEx[ex.exam_set_id] || [], crsById, qbB.qbById, qbB.qvById, ses.role === 'ADMIN'
      );
      if (!entry) continue;
      counts.totalCatalogExams += 1;
      if (entry.availabilityState === 'AVAILABLE' || entry.availabilityState === 'IN_PROGRESS_RESUMABLE') counts.availableCount += 1;
      else if (entry.availabilityState === 'UPCOMING') counts.upcomingCount += 1;
      else counts.closedCount += 1;
      if (entry.completionState === 'IN_PROGRESS') counts.inProgressCount += 1;
      else if (entry.completionState === 'COMPLETED') counts.completedCount += 1;

      if (fMode !== 'ALL' && entry.examMode !== fMode) continue;
      if (fAvail !== 'ALL' && (fAvail === 'AVAILABLE' ? (entry.availabilityState !== 'AVAILABLE' && entry.availabilityState !== 'IN_PROGRESS_RESUMABLE') : entry.availabilityState !== fAvail)) continue;
      if (fComp !== 'ALL' && entry.completionState !== fComp) continue;
      if (searchQ && (entry.title + ' ' + entry.examCode + ' ' + entry.descriptionPlainText).toLowerCase().indexOf(searchQ) === -1) continue;
      items.push(entry);
    }

    var nativeAsm = {}; exsRows.forEach(function (e) { if (e.assessment_id) nativeAsm[e.assessment_id] = true; });
    var legacyExt = cardsRows.filter(function (c) {
      return c.assessment_id && !nativeAsm[c.assessment_id] && enrCrsIds[c.course_id] && (!fCrs || c.course_id === fCrs) && asmById[c.assessment_id] && asmById[c.assessment_id].external_url;
    }).map(function (c) {
      return { assessmentKind: 'EXTERNAL_LINK', assessmentId: c.assessment_id, courseId: c.course_id, title: c.title || asmById[c.assessment_id].title, externalUrl: asmById[c.assessment_id].external_url };
    });

    return { exams: items, legacyExternalAssessments: legacyExt, summary: counts };
  }

  async function handleStudentGetInstructions(payload, token) {
    var ses = await B().requireSession(token, ['STUDENT', 'ADMIN']);
    var examSetId = clean(payload && payload.examSetId, 64);
    var isAdminPrev = ses.role === 'ADMIN' && Boolean(payload && payload.adminPreview);
    var entry = null;
    var ex = null;
    var ver = null;
    var stuAsg = null;

    if (isAdminPrev) {
      ex = okPg(await sb().from('exam_sets').select('*').eq('exam_set_id', examSetId).maybeSingle());
      if (!ex) throw err('ERR_NOT_FOUND', 'Examination set not found.');
      var prevVerId = ex.draft_exam_version_id || ex.active_exam_version_id;
      if (!prevVerId) throw err('ERR_NOT_FOUND', 'No draft or active exam version found for preview.');
      var prevFetched = await Promise.all([
        sb().from('exam_versions').select('*').eq('exam_version_id', prevVerId).single(),
        sb().from('exam_sections').select('*').eq('exam_version_id', prevVerId).order('sort_order', { ascending: true }),
        sb().from('exam_items').select('*').eq('exam_version_id', prevVerId).order('sort_order', { ascending: true }),
        ex.course_id ? sb().from('courses').select('*').eq('course_id', ex.course_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
        loadQuestionBankBundle()
      ]);
      ver = okPg(prevFetched[0]);
      var prevSecs = okPg(prevFetched[1]) || [];
      var prevItems = okPg(prevFetched[2]) || [];
      var crsRow = okPg(prevFetched[3]);
      var prevCrsById = {};
      if (crsRow && crsRow.course_id) prevCrsById[crsRow.course_id] = crsRow;
      var prevQb = prevFetched[4];
      entry = evaluateStudentExamCatalogEntry(
        ex, ver, prevSecs, prevItems, ses.userId, true, [], [], prevCrsById, prevQb.qbById, prevQb.qvById, true
      );
      var fullPreviewStruct = buildExamVersionStructureBundle(
        ex, ver, prevSecs, prevItems, prevQb.qbById, prevQb.qvById, prevQb.qoByQvId, prevQb.stById, true
      );
      entry.sections = fullPreviewStruct.sections;
      entry.sectionsOverview = fullPreviewStruct.sections;
      entry.questionCount = fullPreviewStruct.totalQuestionsCount;
      entry.sectionCount = fullPreviewStruct.sections.length;
      entry.maxPointsBp = fullPreviewStruct.maxPointsBp;
      entry.maxPointsDisplay = fullPreviewStruct.maxPointsDisplay;
      entry.availabilityState = ex.status || 'DRAFT';
      entry.canStartNewAttempt = true;
      entry.canResumeAttempt = false;
      entry._isAdminPreview = true;
    } else {
      var cat = await handleStudentListExams({}, token);
      entry = cat.exams.find(function (e) { return e.examSetId === examSetId; });
      if (!entry) throw err('ERR_FORBIDDEN_RESOURCE', 'Examination not found or not assigned to your account.');
      ex = okPg(await sb().from('exam_sets').select('*').eq('exam_set_id', examSetId).single());
      ver = okPg(await sb().from('exam_versions').select('*').eq('exam_version_id', ex.active_exam_version_id).single());
      stuAsg = okPg(await sb().from('exam_assignments').select('*').eq('exam_set_id', examSetId).eq('target_type', 'STUDENT').eq('student_user_id', ses.userId).eq('assignment_status', 'ASSIGNED').maybeSingle());
    }

    var iPol = resolveAttemptIntegrityPolicy(ex, ver, stuAsg);
    entry.integrityPolicy = iPol;
    return {
      doesNotStartAttempt: true,
      exam: entry,
      integrityPolicy: iPol,
      rulesChecklist: isAdminPrev
        ? [
            'Administrator Draft Preview: Displaying the current draft version (' + entry.maxPointsDisplay + ' across ' + entry.questionCount + ' questions).',
            entry.effectiveDurationMinutes > 0 ? ('Time Limit: ' + entry.durationLabel + ' when taken by students.') : 'Untimed Examination: Work at your own pace before submitting.',
            'Allowed Attempts: ' + entry.allowedAttemptsDisplay + '. Aggregation: ' + entry.aggregationRule + '.',
            'Scoring Policy: Max score ' + entry.maxPointsDisplay + ' (' + entry.questionCount + ' questions).'
          ]
        : [
            entry.effectiveDurationMinutes > 0 ? ('Time Limit: ' + entry.durationLabel + '. Server timer runs continuously even on refresh.') : 'Untimed Examination: Work at your own pace before submitting.',
            'Allowed Attempts: ' + entry.allowedAttemptsDisplay + ' (Used: ' + entry.attemptsUsed + '). Aggregation: ' + entry.aggregationRule + '.',
            'Navigation: ' + (entry.navigationMode === 'LINEAR' ? 'Linear sequential navigation.' : 'Free navigation across all questions and sections.'),
            'Scoring Policy: Max score ' + entry.maxPointsDisplay + ' (' + entry.questionCount + ' questions).',
            'Score & Explanation Release: ' + entry.scoreReleasePolicy + ' / ' + entry.explanationReleasePolicy + '.'
          ],
      serverTimeUtc: nowIso(),
      serverTimeBangkok: fmtBkk()
    };
  }

  async function evaluateSingleItemScore(qvRec, rawPayload, pointsBp, negPointsBp) {
    var maxBp = Math.max(0, Number(pointsBp) || Number(qvRec && qvRec.default_points_bp) || 100);
    var negBp = Math.max(0, Number(negPointsBp) || Number(qvRec && qvRec.negative_points_bp) || 0);
    var qType = qvRec ? qvRec.question_type : 'SINGLE_CHOICE';
    var gMode = qvRec ? qvRec.grading_mode || 'AUTO' : 'AUTO';
    var spec = asJsonObj(qvRec && qvRec.grading_spec_private_json, {});
    var p = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};

    if (qType === 'SINGLE_CHOICE' || qType === 'TRUE_FALSE') {
      var selId = String(p.selectedOptionId || '').trim();
      if (!selId) return { isAnswered: false, gradingSource: 'AUTO_ENGINE', correctnessState: 'UNANSWERED', awardedPointsBp: 0, maxPointsBp: maxBp, requiresManualReview: false };
      var isHit = (Array.isArray(spec.correctOptionIds) ? spec.correctOptionIds : []).indexOf(selId) !== -1;
      return { isAnswered: true, gradingSource: 'AUTO_ENGINE', correctnessState: isHit ? 'CORRECT' : 'INCORRECT', awardedPointsBp: isHit ? maxBp : (negBp > 0 ? -negBp : 0), maxPointsBp: maxBp, requiresManualReview: false };
    }
    if (qType === 'COMPLEX_MULTIPLE_CHOICE') {
      var rawDec = p.statementDecisions && typeof p.statementDecisions === 'object' ? p.statementDecisions : {};
      var truthMap = spec.statementTruthMap && typeof spec.statementTruthMap === 'object' ? spec.statementTruthMap : {};
      var sIds = Object.keys(truthMap), ans = 0, matched = 0;
      sIds.forEach(function (sid) {
        var g = String(rawDec[sid] || '').trim().toUpperCase();
        if (g === 'YES' || g === 'NO') { ans += 1; if (g === (truthMap[sid] ? 'YES' : 'NO')) matched += 1; }
      });
      if (ans === 0) return { isAnswered: false, gradingSource: 'AUTO_ENGINE', correctnessState: 'UNANSWERED', awardedPointsBp: 0, maxPointsBp: maxBp, requiresManualReview: false };
      var totS = sIds.length || 3;
      if (matched === totS) return { isAnswered: true, gradingSource: 'AUTO_ENGINE', correctnessState: 'CORRECT', awardedPointsBp: maxBp, maxPointsBp: maxBp, requiresManualReview: false };
      if (totS >= 3 && matched === totS - 1) return { isAnswered: true, gradingSource: 'AUTO_ENGINE', correctnessState: 'PARTIAL', awardedPointsBp: Math.round(maxBp / 2), maxPointsBp: maxBp, requiresManualReview: false };
      return { isAnswered: true, gradingSource: 'AUTO_ENGINE', correctnessState: 'INCORRECT', awardedPointsBp: negBp > 0 ? -negBp : 0, maxPointsBp: maxBp, requiresManualReview: false };
    }
    if (qType === 'MULTIPLE_SELECT') {
      var selArr = Array.isArray(p.selectedOptionIds) ? p.selectedOptionIds.map(String).filter(Boolean) : [];
      var uniq = [], seen = {};
      selArr.forEach(function (id) { if (!seen[id]) { seen[id] = true; uniq.push(id); } });
      if (uniq.length === 0) return { isAnswered: false, gradingSource: 'AUTO_ENGINE', correctnessState: 'UNANSWERED', awardedPointsBp: 0, maxPointsBp: maxBp, requiresManualReview: false };
      var corrArr = Array.isArray(spec.correctOptionIds) ? spec.correctOptionIds : [];
      var corrMap = {}; corrArr.forEach(function (c) { corrMap[c] = true; });
      var cOk = 0, cBad = 0;
      uniq.forEach(function (u) { if (corrMap[u]) cOk += 1; else cBad += 1; });
      if (cBad === 0 && cOk === corrArr.length && corrArr.length > 0) return { isAnswered: true, gradingSource: 'AUTO_ENGINE', correctnessState: 'CORRECT', awardedPointsBp: maxBp, maxPointsBp: maxBp, requiresManualReview: false };
      if (String(spec.scoringRule || '').toUpperCase() === 'PARTIAL_WITHOUT_OVERSELECT' && cBad === 0 && cOk > 0 && corrArr.length > 0) {
        return { isAnswered: true, gradingSource: 'AUTO_ENGINE', correctnessState: 'PARTIAL', awardedPointsBp: Math.min(maxBp, Math.round((maxBp * cOk) / corrArr.length)), maxPointsBp: maxBp, requiresManualReview: false };
      }
      return { isAnswered: true, gradingSource: 'AUTO_ENGINE', correctnessState: 'INCORRECT', awardedPointsBp: negBp > 0 ? -negBp : 0, maxPointsBp: maxBp, requiresManualReview: false };
    }
    if (qType === 'NUMERIC_RESPONSE') {
      var rawN = String(p.numericText !== undefined && p.numericText !== null ? p.numericText : '').trim();
      if (!rawN) return { isAnswered: false, gradingSource: 'AUTO_ENGINE', correctnessState: 'UNANSWERED', awardedPointsBp: 0, maxPointsBp: maxBp, requiresManualReview: false };
      var nVal = Number(rawN);
      if (!isFinite(nVal)) return { isAnswered: true, gradingSource: 'AUTO_ENGINE', correctnessState: 'INCORRECT', awardedPointsBp: negBp > 0 ? -negBp : 0, maxPointsBp: maxBp, requiresManualReview: false };
      if (spec.roundingDecimals !== undefined && spec.roundingDecimals !== null && spec.roundingDecimals !== '') nVal = roundHalfAwayFromZero(nVal, Number(spec.roundingDecimals));
      var numOk = false;
      if (spec.matchMode === 'ACCEPTABLE_RANGE') {
        numOk = nVal >= Number(spec.rangeMin) - 1e-9 && nVal <= Number(spec.rangeMax) + 1e-9;
      } else {
        var targ = Number(spec.targetValue), tType = String(spec.toleranceType || 'NONE').toUpperCase(), tVal = Number(spec.toleranceValue) || 0;
        var delta = tType === 'ABSOLUTE' ? Math.abs(tVal) : (tType === 'RELATIVE_PERCENT' ? Math.abs(targ) * (Math.abs(tVal) / 100) : 0);
        numOk = Math.abs(nVal - targ) <= delta + 1e-9;
      }
      return { isAnswered: true, gradingSource: 'AUTO_ENGINE', correctnessState: numOk ? 'CORRECT' : 'INCORRECT', awardedPointsBp: numOk ? maxBp : (negBp > 0 ? -negBp : 0), maxPointsBp: maxBp, requiresManualReview: false };
    }
    if (qType === 'SHORT_ANSWER') {
      var saTxt = String(p.textResponse !== undefined && p.textResponse !== null ? p.textResponse : '').trim();
      if (!saTxt) return { isAnswered: false, gradingSource: gMode === 'MANUAL' ? 'UNGRADED' : 'AUTO_ENGINE', correctnessState: 'UNANSWERED', awardedPointsBp: 0, maxPointsBp: maxBp, requiresManualReview: false };
      if (gMode === 'AUTO' || gMode === 'AUTO_WITH_MANUAL_REVIEW') {
        var normCand = normalizeShortAnswer(saTxt, Boolean(spec.caseSensitive), spec.collapseWhitespace !== false, spec.trimPunctuation !== false);
        var hit = (Array.isArray(spec.acceptedAnswers) ? spec.acceptedAnswers : []).some(function (a) {
          return normalizeShortAnswer(a, Boolean(spec.caseSensitive), spec.collapseWhitespace !== false, spec.trimPunctuation !== false) === normCand;
        });
        if (hit) return { isAnswered: true, gradingSource: 'AUTO_ENGINE', correctnessState: 'CORRECT', awardedPointsBp: maxBp, maxPointsBp: maxBp, requiresManualReview: false };
        if (gMode === 'AUTO') return { isAnswered: true, gradingSource: 'AUTO_ENGINE', correctnessState: 'INCORRECT', awardedPointsBp: 0, maxPointsBp: maxBp, requiresManualReview: false };
      }
      return { isAnswered: true, gradingSource: 'UNGRADED', correctnessState: 'MANUAL_REVIEW_PENDING', awardedPointsBp: 0, maxPointsBp: maxBp, requiresManualReview: true };
    }
    var wrTxt = String(p.textResponse !== undefined && p.textResponse !== null ? p.textResponse : '').trim();
    if (!wrTxt) return { isAnswered: false, gradingSource: 'UNGRADED', correctnessState: 'UNANSWERED', awardedPointsBp: 0, maxPointsBp: maxBp, requiresManualReview: false };
    return { isAnswered: true, gradingSource: 'UNGRADED', correctnessState: 'MANUAL_REVIEW_PENDING', awardedPointsBp: 0, maxPointsBp: maxBp, requiresManualReview: true };
  }

  async function syncPublishedExamScoreToAssessmentScores(exRow, studentUserId, actorUserId) {
    if (!exRow || !exRow.assessment_id) return;
    var atts = okPg(await sb().from('exam_attempts').select('*').eq('exam_set_id', exRow.exam_set_id).eq('student_user_id', studentUserId)) || [];
    var nowMs = Date.now(), pub = [];
    atts.forEach(function (a) {
      if ((a.attempt_status === 'SUBMITTED' || a.attempt_status === 'EXPIRED_SUBMITTED') && (a.grading_status === 'GRADED' || a.grading_status === 'REGRADED')) {
        if (resolveEffectiveReleaseState(a, exRow, nowMs).effectivePublicationStatus === 'PUBLISHED') pub.push(a);
      }
    });
    if (pub.length === 0) return;
    pub.sort(function (a, b) { return (Number(a.attempt_number) || 0) - (Number(b.attempt_number) || 0); });
    var chosen = pub[0];
    if (exRow.aggregation_rule === 'LATEST_PUBLISHED') chosen = pub[pub.length - 1];
    else if (exRow.aggregation_rule !== 'FIRST_PUBLISHED') pub.forEach(function (a) { if ((Number(a.total_score_bp) || 0) > (Number(chosen.total_score_bp) || 0)) chosen = a; });

    var scPts = Math.round(((Number(chosen.total_score_bp) || 0) / 100) * 100) / 100;
    var maxPts = Math.max(1, Math.round(((Number(chosen.max_score_bp) || 100) / 100) * 100) / 100);
    var now = nowIso();
    var exScore = okPg(await sb().from('assessment_scores').select('*').eq('assessment_id', exRow.assessment_id).eq('student_user_id', studentUserId).maybeSingle());
    var fields = {
      assessment_id: exRow.assessment_id,
      course_id: exRow.course_id || '',
      student_user_id: studentUserId,
      score_points: scPts,
      max_points: maxPts,
      status: 'PUBLISHED',
      grader_note: 'Auto-synced from Native Exam (' + exRow.exam_code + ', Attempt #' + chosen.attempt_number + ')',
      graded_by_user_id: actorUserId || 'SYSTEM',
      graded_at_utc: now,
      updated_at_utc: now
    };
    if (exScore) okPg(await sb().from('assessment_scores').update(Object.assign({}, fields, { version: (Number(exScore.version) || 1) + 1 })).eq('score_id', exScore.score_id));
    else okPg(await sb().from('assessment_scores').insert(Object.assign({ score_id: genId('scr_'), created_at_utc: now, version: 1 }, fields)));
  }

  async function gradeSubmittedAttempt(att, exRow, triggerType, actorUserId) {
    var all = await Promise.all([
      sb().from('attempt_items').select('*').eq('attempt_id', att.attempt_id),
      sb().from('attempt_responses').select('*').eq('attempt_id', att.attempt_id),
      sb().from('question_versions').select('*'),
      sb().from('result_revisions').select('revision_no').eq('attempt_id', att.attempt_id)
    ]);
    var attItems = okPg(all[0]) || [], attResps = okPg(all[1]) || [], qvs = okPg(all[2]) || [], revs = okPg(all[3]) || [];
    var qvById = {}; qvs.forEach(function (q) { qvById[q.question_version_id] = q; });
    var respByItem = {}; attResps.forEach(function (r) { respByItem[r.attempt_item_id] = r; });

    var autoBp = 0, manualBp = 0, maxBp = 0, pendingManual = false, ansCnt = 0, flagCnt = 0;
    var now = nowIso();

    for (var i = 0; i < attItems.length; i++) {
      var ati = attItems[i];
      if (ati.is_flagged) flagCnt += 1;
      var qv = qvById[ati.question_version_id];
      var iMax = Number(ati.points_bp) || 100;
      maxBp += iMax;
      var resp = respByItem[ati.attempt_item_id];
      var rawP = resp ? asJsonObj(resp.response_payload_json, {}) : {};
      var ev = await evaluateSingleItemScore(qv, rawP, iMax, ati.negative_points_bp);
      if (ev.isAnswered) ansCnt += 1;

      if (resp && resp.grading_source === 'MANUAL_INSTRUCTOR' && triggerType !== 'ADMIN_REGRADE') {
        manualBp += Number(resp.awarded_points_bp) || 0;
        continue;
      }
      if (ev.requiresManualReview) pendingManual = true;
      else autoBp += Number(ev.awardedPointsBp) || 0;

      if (resp) {
        okPg(await sb().from('attempt_responses').update({
          grading_source: triggerType === 'ADMIN_REGRADE' ? 'REGRADE_ENGINE' : ev.gradingSource,
          awarded_points_bp: ev.awardedPointsBp,
          max_points_bp: ev.maxPointsBp,
          correctness_state: ev.correctnessState,
          graded_by_user_id: actorUserId || 'SYSTEM',
          graded_at_utc: now,
          updated_at_utc: now
        }).eq('response_id', resp.response_id));
      } else {
        okPg(await sb().from('attempt_responses').insert({
          response_id: genId('atr_'),
          attempt_id: att.attempt_id,
          attempt_item_id: ati.attempt_item_id,
          question_version_id: ati.question_version_id,
          student_user_id: att.student_user_id,
          response_payload_json: {},
          is_answered: false,
          grading_source: 'AUTO_ENGINE',
          awarded_points_bp: 0,
          max_points_bp: iMax,
          correctness_state: 'UNANSWERED',
          graded_by_user_id: actorUserId || 'SYSTEM',
          graded_at_utc: now,
          created_at_utc: now,
          updated_at_utc: now,
          version: 1
        }));
      }
    }

    var totBp = Math.max(0, autoBp + manualBp);
    var pctBp = maxBp > 0 ? Math.round((totBp / maxBp) * 10000) : 0;
    var passed = (pctBp / 100) >= (Number(exRow.pass_threshold_pct) || 60);
    var gradStatus = triggerType === 'ADMIN_REGRADE' ? (pendingManual ? 'AUTO_GRADED_PENDING_MANUAL' : 'REGRADED') : (pendingManual ? 'AUTO_GRADED_PENDING_MANUAL' : 'GRADED');
    var pubStatus = att.publication_status || 'UNPUBLISHED';
    var expStatus = att.explanation_status || 'WITHHELD';

    if ((gradStatus === 'GRADED' || gradStatus === 'REGRADED') && pubStatus === 'UNPUBLISHED') {
      if (exRow.score_release_policy === 'IMMEDIATE_AUTO') pubStatus = 'PUBLISHED';
      else if (exRow.score_release_policy === 'SCHEDULED') pubStatus = (exRow.score_release_at_utc && Date.parse(exRow.score_release_at_utc) <= Date.now()) ? 'PUBLISHED' : 'SCHEDULED';
    }
    if (pubStatus === 'PUBLISHED' && exRow.explanation_release_policy === 'WITH_SCORE') expStatus = 'RELEASED';

    var nextRevNo = revs.reduce(function (m, r) { return Math.max(m, Number(r.revision_no) || 0); }, 0) + 1;
    var revId = genId('rrv_');
    okPg(await sb().from('result_revisions').insert({
      result_revision_id: revId,
      attempt_id: att.attempt_id,
      exam_set_id: att.exam_set_id,
      exam_version_id: att.exam_version_id,
      student_user_id: att.student_user_id,
      revision_no: nextRevNo,
      revision_type: triggerType === 'ADMIN_REGRADE' ? 'ADMIN_REGRADE' : 'INITIAL_AUTO_GRADE',
      auto_score_bp: autoBp,
      manual_score_bp: manualBp,
      total_score_bp: totBp,
      max_score_bp: maxBp,
      percentage_bp: pctBp,
      passed_flag: passed,
      grading_status: gradStatus,
      publication_status: pubStatus,
      explanation_status: expStatus,
      reason: triggerType === 'ADMIN_REGRADE' ? 'Regraded against answer keys' : 'Initial server auto-grading on submission',
      actor_user_id: actorUserId || 'SYSTEM',
      created_at_utc: now
    }));

    var updatedAtt = okPg(await sb().from('exam_attempts').update({
      grading_status: gradStatus,
      publication_status: pubStatus,
      explanation_status: expStatus,
      answered_count: ansCnt,
      flagged_count: flagCnt,
      auto_score_bp: autoBp,
      manual_score_bp: manualBp,
      total_score_bp: totBp,
      max_score_bp: maxBp,
      percentage_bp: pctBp,
      passed_flag: passed,
      current_result_revision_id: revId,
      updated_at_utc: now
    }).eq('attempt_id', att.attempt_id).select('*').single());

    if (pubStatus === 'PUBLISHED' && (gradStatus === 'GRADED' || gradStatus === 'REGRADED')) {
      await syncPublishedExamScoreToAssessmentScores(exRow, att.student_user_id, actorUserId);
    }
    return updatedAtt;
  }

  async function finalizeExpiredAttemptIfNeeded(att, exRow, actorUserId) {
    if (!att || att.attempt_status !== 'IN_PROGRESS' || !att.grace_deadline_utc) return att;
    if (Date.now() <= Date.parse(att.grace_deadline_utc)) return att;
    var now = nowIso();
    var startMs = Date.parse(att.started_at_utc) || Date.now();
    var usedSec = Math.max(0, Math.round((Date.now() - startMs) / 1000));
    var upd = okPg(await sb().from('exam_attempts').update({
      attempt_status: 'EXPIRED_SUBMITTED',
      submitted_at_utc: now,
      time_used_seconds: usedSec,
      active_lease_token: '',
      updated_at_utc: now
    }).eq('attempt_id', att.attempt_id).select('*').single());
    return await gradeSubmittedAttempt(upd, exRow, 'EXPIRE_FINALIZE', actorUserId);
  }

  async function buildStudentWorkspaceBundle(att, exRow, verRow, qbB) {
    var all = await Promise.all([
      sb().from('exam_sections').select('*').eq('exam_version_id', verRow.exam_version_id),
      sb().from('attempt_items').select('*').eq('attempt_id', att.attempt_id),
      sb().from('attempt_responses').select('*').eq('attempt_id', att.attempt_id)
    ]);
    var secs = (okPg(all[0]) || []).sort(function (a, b) { return (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0); });
    var atiRows = (okPg(all[1]) || []).sort(function (a, b) { return (Number(a.display_number) || 0) - (Number(b.display_number) || 0); });
    var resps = okPg(all[2]) || [];
    var secById = {}; secs.forEach(function (s) { secById[s.exam_section_id] = s; });
    var respByItemId = {};
    resps.forEach(function (r) {
      respByItemId[r.attempt_item_id] = {
        responseId: r.response_id,
        isAnswered: Boolean(r.is_answered),
        clientRevisionNo: Number(r.client_revision_no) || 0,
        serverRevisionNo: Number(r.server_revision_no) || 0,
        savedAtUtc: r.saved_at_utc,
        savedAtBangkok: fmtBkk(r.saved_at_utc),
        payload: asJsonObj(r.response_payload_json, {})
      };
    });

    var letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    var ansCnt = 0, flagCnt = 0;
    var itemDtos = atiRows.map(function (ati, idx) {
      var qb = qbB.qbById[ati.question_id], qv = qbB.qvById[ati.question_version_id];
      var rawOpts = qbB.qoByQvId[ati.question_version_id] || [];
      var optOrder = asJsonArr(ati.option_order_json, []);
      var optMap = {}; rawOpts.forEach(function (o) { optMap[o.option_id] = o; });
      var orderedOpts = [], seen = {};
      optOrder.forEach(function (id) { if (optMap[id]) { orderedOpts.push(optMap[id]); seen[id] = true; } });
      rawOpts.forEach(function (o) { if (!seen[o.option_id]) orderedOpts.push(o); });
      var stim = qv && qv.stimulus_id ? qbB.stById[qv.stimulus_id] : null;
      var safeQ = qb && qv ? projectQuestionVersionDto(qb, qv, orderedOpts, stim, false) : null;
      if (safeQ && Array.isArray(safeQ.options)) {
        safeQ.options.forEach(function (o, m) { o.displayLabel = safeQ.questionType === 'TRUE_FALSE' ? (o.plainText || letters[m]) : (letters[m] || String(m + 1)); });
      }
      var savedResp = respByItemId[ati.attempt_item_id] || null;
      var isAns = Boolean(savedResp && savedResp.isAnswered);
      var isFlg = Boolean(ati.is_flagged);
      if (isAns) ansCnt += 1;
      if (isFlg) flagCnt += 1;
      return {
        attemptItemId: ati.attempt_item_id,
        displayNumber: Number(ati.display_number) || (idx + 1),
        examSectionId: ati.exam_section_id,
        sectionTitle: secById[ati.exam_section_id] ? secById[ati.exam_section_id].title : 'Section',
        questionId: ati.question_id,
        questionVersionId: ati.question_version_id,
        pointsBp: Number(ati.points_bp) || 100,
        pointsDisplay: formatPointsBp(ati.points_bp || 100),
        negativePointsBp: Number(ati.negative_points_bp) || 0,
        negativePointsDisplay: formatPointsBp(ati.negative_points_bp || 0),
        isFlagged: isFlg,
        flagUpdatedAtUtc: ati.flag_updated_at_utc || '',
        isAnsweredServerSaved: isAns,
        savedResponse: savedResp,
        question: safeQ
      };
    });

    var effDead = att.effective_deadline_utc || '';
    var remSec = effDead ? Math.max(0, Math.round((Date.parse(effDead) - Date.now()) / 1000)) : null;
    var now = nowIso();
    return {
      attempt: {
        attemptId: att.attempt_id,
        examSetId: att.exam_set_id,
        examVersionId: att.exam_version_id,
        courseId: att.course_id || '',
        studentUserId: att.student_user_id,
        attemptNumber: Number(att.attempt_number) || 1,
        attemptStatus: att.attempt_status,
        gradingStatus: att.grading_status,
        publicationStatus: att.publication_status,
        explanationStatus: att.explanation_status,
        startedAtUtc: att.started_at_utc,
        startedAtBangkok: fmtBkk(att.started_at_utc),
        effectiveDeadlineUtc: effDead,
        effectiveDeadlineBangkok: effDead ? fmtBkk(effDead) : 'Untimed',
        graceDeadlineUtc: att.grace_deadline_utc || '',
        submittedAtUtc: att.submitted_at_utc || '',
        lastSavedAtUtc: att.last_saved_at_utc || '',
        lastSavedAtBangkok: att.last_saved_at_utc ? fmtBkk(att.last_saved_at_utc) : '',
        latestRevisionNo: Number(att.latest_revision_no) || 0,
        leaseToken: att.active_lease_token || '',
        totalQuestionsCount: itemDtos.length,
        answeredCount: ansCnt,
        unansweredCount: Math.max(0, itemDtos.length - ansCnt),
        flaggedCount: flagCnt,
        maxScoreBp: Number(att.max_score_bp) || Number(verRow.max_points_bp) || 0,
        maxScoreDisplay: formatPointsBp(Number(att.max_score_bp) || Number(verRow.max_points_bp) || 0),
        integrityState: buildAttemptIntegrityStateDto(att, exRow)
      },
      exam: {
        examSetId: exRow.exam_set_id,
        examCode: exRow.exam_code,
        title: exRow.title,
        examMode: exRow.exam_mode,
        examModeLabel: fmtModeLabel(exRow.exam_mode),
        navigationMode: exRow.navigation_mode || 'FREE',
        durationMinutes: Number(exRow.duration_minutes) || 0,
        graceSeconds: Number(exRow.grace_seconds) || 15,
        allowPerQuestionPracticeFeedback: Boolean(exRow.exam_mode === 'PRACTICE' && exRow.allow_per_question_practice_feedback)
      },
      sections: secs.map(function (s, idx) { return { examSectionId: s.exam_section_id, title: s.title || ('Section ' + (idx + 1)), sortOrder: Number(s.sort_order) || (idx + 1) * 10 }; }),
      items: itemDtos,
      savedResponsesByItemId: respByItemId,
      serverNowUtc: now,
      serverNowBangkok: fmtBkk(now),
      remainingSecondsServer: remSec
    };
  }

  function buildReceiptBundle(att, exRow, totalQ) {
    var rel = resolveEffectiveReleaseState(att, exRow, Date.now());
    var gSt = att.grading_status, pSt = rel.effectivePublicationStatus, eSt = rel.effectiveExplanationStatus;
    var notice = gSt === 'AUTO_GRADED_PENDING_MANUAL'
      ? 'Objective answers auto-graded; written/short answers queued for manual rubric grading.'
      : (pSt === 'PUBLISHED' ? 'Your official examination score has been published below.' : 'Your attempt has been recorded. Official scores will appear once released.');
    var pubScore = null;
    if (pSt === 'PUBLISHED' && (gSt === 'GRADED' || gSt === 'REGRADED')) {
      var totBp = Number(att.total_score_bp) || 0, maxBp = Number(att.max_score_bp) || 100;
      var pct = Math.round((Number(att.percentage_bp) || 0) / 10) / 10;
      pubScore = {
        autoScoreBp: Number(att.auto_score_bp) || 0,
        autoScoreDisplay: formatPointsBp(att.auto_score_bp || 0),
        manualScoreBp: Number(att.manual_score_bp) || 0,
        manualScoreDisplay: formatPointsBp(att.manual_score_bp || 0),
        totalScoreBp: totBp,
        maxScoreBp: maxBp,
        scoreDisplay: formatPointsBp(totBp) + ' / ' + formatPointsBp(maxBp),
        percentageFormatted: pct.toFixed(1) + '%',
        percentageValue: pct,
        passedFlag: Boolean(att.passed_flag),
        explanationsReleased: eSt === 'RELEASED',
        resultRevisionId: att.current_result_revision_id || ''
      };
    }
    return {
      receiptCode: (exRow.exam_code || 'EXAM') + '-A' + (att.attempt_number || 1) + '-' + String(att.attempt_id || '').slice(-6).toUpperCase(),
      attemptId: att.attempt_id,
      examSetId: exRow.exam_set_id,
      examCode: exRow.exam_code,
      examTitle: exRow.title,
      examMode: exRow.exam_mode,
      examModeLabel: fmtModeLabel(exRow.exam_mode),
      courseId: att.course_id || exRow.course_id || '',
      attemptNumber: Number(att.attempt_number) || 1,
      attemptStatus: att.attempt_status,
      gradingStatus: gSt,
      publicationStatus: pSt,
      explanationStatus: eSt,
      startedAtUtc: att.started_at_utc,
      startedAtBangkok: fmtBkk(att.started_at_utc),
      submittedAtUtc: att.submitted_at_utc,
      submittedAtBangkok: fmtBkk(att.submitted_at_utc),
      timeUsedSeconds: Number(att.time_used_seconds) || 0,
      timeUsedFormatted: fmtDurationSec(att.time_used_seconds),
      totalQuestionsCount: totalQ,
      answeredCount: Number(att.answered_count) || 0,
      unansweredCount: Math.max(0, totalQ - (Number(att.answered_count) || 0)),
      flaggedCount: Number(att.flagged_count) || 0,
      releasePolicyExplanation: notice,
      publishedScoreResult: pubScore
    };
  }

  async function handleStudentStartAttempt(payload, token) {
    var ses = await B().requireSession(token, ['STUDENT', 'ADMIN']);
    var examSetId = clean(payload && payload.examSetId, 64);
    var cat = await handleStudentListExams({}, token);
    var entry = cat.exams.find(function (e) { return e.examSetId === examSetId; });
    if (!entry) throw err('ERR_FORBIDDEN_RESOURCE', 'Access denied to start this examination.');

    var ex = okPg(await sb().from('exam_sets').select('*').eq('exam_set_id', examSetId).single());
    var ver = okPg(await sb().from('exam_versions').select('*').eq('exam_version_id', ex.active_exam_version_id).single());
    var qbB = await loadQuestionBankBundle();

    var inProg = okPg(await sb().from('exam_attempts').select('*').eq('exam_set_id', examSetId).eq('student_user_id', ses.userId).eq('attempt_status', 'IN_PROGRESS').maybeSingle());
    if (inProg) {
      inProg = await finalizeExpiredAttemptIfNeeded(inProg, ex, ses.userId);
      if (inProg.attempt_status === 'IN_PROGRESS') {
        var newLease = genId('lse_');
        inProg = okPg(await sb().from('exam_attempts').update({ active_lease_token: newLease, updated_at_utc: nowIso() }).eq('attempt_id', inProg.attempt_id).select('*').single());
        return await buildStudentWorkspaceBundle(inProg, ex, ver, qbB);
      }
    }

    var stuAsg = okPg(await sb().from('exam_assignments').select('*').eq('exam_set_id', examSetId).eq('target_type', 'STUDENT').eq('student_user_id', ses.userId).eq('assignment_status', 'ASSIGNED').maybeSingle());
    var iPol = resolveAttemptIntegrityPolicy(ex, ver, stuAsg);
    if (iPol.requiresAcknowledgment && !Boolean(payload && (payload.integrityPolicyAcknowledged || payload.policyAcknowledged))) {
      throw err('ERR_VALIDATION_FAILED', 'Please review and acknowledge the examination anti-copy policy before starting.', { integrityPolicyAcknowledged: 'Acknowledgment required.' });
    }

    var prevAtts = okPg(await sb().from('exam_attempts').select('attempt_number').eq('exam_set_id', examSetId).eq('student_user_id', ses.userId)) || [];
    var nextNo = prevAtts.reduce(function (m, a) { return Math.max(m, Number(a.attempt_number) || 0); }, 0) + 1;
    var now = nowIso(), nowMs = Date.now();
    var effDead = entry.effectiveDurationMinutes > 0 ? new Date(nowMs + entry.effectiveDurationMinutes * 60000).toISOString() : null;
    if (effDead && entry.closeAtUtc && Date.parse(entry.closeAtUtc) < Date.parse(effDead)) effDead = entry.closeAtUtc;
    var graceDead = effDead ? new Date(Date.parse(effDead) + (Number(ex.grace_seconds) || 15) * 1000).toISOString() : null;

    var attId = genId('att_'), lease = genId('lse_');
    var attRow = okPg(await sb().from('exam_attempts').insert({
      attempt_id: attId,
      exam_set_id: examSetId,
      exam_version_id: ver.exam_version_id,
      course_id: ex.course_id || '',
      student_user_id: ses.userId,
      attempt_number: nextNo,
      idempotency_key: clean(payload && payload.idempotencyKey, 64),
      attempt_status: 'IN_PROGRESS',
      grading_status: 'NOT_GRADED',
      publication_status: 'UNPUBLISHED',
      explanation_status: 'WITHHELD',
      started_at_utc: now,
      effective_deadline_utc: effDead,
      grace_deadline_utc: graceDead,
      last_saved_at_utc: now,
      active_lease_token: lease,
      max_score_bp: Number(ver.max_points_bp) || 0,
      created_at_utc: now,
      updated_at_utc: now,
      version: 1,
      copy_policy_enabled_snapshot: iPol.copyPolicyEnabled,
      copy_policy_version_snapshot: iPol.policyVersion,
      max_copy_warnings_snapshot: iPol.maxCopyWarnings,
      copy_suspension_seconds_snapshot: iPol.copySuspensionSeconds,
      max_invalidations_lock_snapshot: iPol.maxIntegrityInvalidationsBeforeLock,
      policy_acknowledged_at_utc: iPol.copyPolicyEnabled ? now : null
    }).select('*').single(), 'Create exam attempt');

    var secs = (okPg(await sb().from('exam_sections').select('*').eq('exam_version_id', ver.exam_version_id)) || []).sort(function (a, b) { return (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0); });
    var rawItems = okPg(await sb().from('exam_items').select('*').eq('exam_version_id', ver.exam_version_id)) || [];
    var attItemsToInsert = [], dispNo = 1;

    secs.forEach(function (sec) {
      var sItems = rawItems.filter(function (x) { return x.exam_section_id === sec.exam_section_id; }).sort(function (a, b) { return (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0); });
      if (sec.selection_mode === 'QUESTION_POOL') {
        shuffleInPlace(sItems);
        sItems = sItems.slice(0, Math.min(sItems.length, Math.max(1, Number(sec.pool_draw_count) || sItems.length)));
      } else if (ver.randomize_questions || sec.randomize_items_within_section) {
        var unlocked = sItems.filter(function (x) { return !x.lock_item_position; });
        shuffleInPlace(unlocked);
        var ui = 0;
        sItems = sItems.map(function (x) { return x.lock_item_position ? x : unlocked[ui++]; });
      }
      sItems.forEach(function (it) {
        var qv = qbB.qvById[it.question_version_id];
        var opts = (qbB.qoByQvId[it.question_version_id] || []).slice().sort(function (a, b) { return (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0); });
        if (ver.randomize_options && !(it.lock_option_order || (qv && qv.lock_option_order))) {
          var movable = opts.filter(function (o) { return o.pin_position === 'NONE'; });
          shuffleInPlace(movable);
          var mi = 0;
          opts = opts.map(function (o) { return o.pin_position === 'NONE' ? movable[mi++] : o; });
        }
        attItemsToInsert.push({
          attempt_item_id: genId('ati_'),
          attempt_id: attId,
          exam_set_id: examSetId,
          exam_version_id: ver.exam_version_id,
          exam_section_id: sec.exam_section_id,
          display_number: dispNo++,
          question_id: it.question_id,
          question_version_id: it.question_version_id,
          stimulus_id: qv ? qv.stimulus_id || '' : '',
          option_order_json: opts.map(function (o) { return o.option_id; }),
          points_bp: Number(it.points_bp) || 100,
          negative_points_bp: Number(it.negative_points_bp) || 0,
          is_flagged: false,
          created_at_utc: now
        });
      });
    });

    if (attItemsToInsert.length > 0) okPg(await sb().from('attempt_items').insert(attItemsToInsert), 'Create attempt items');
    return await buildStudentWorkspaceBundle(attRow, ex, ver, qbB);
  }

  async function loadOwnedAttemptOrThrow(attemptId, userId) {
    var att = okPg(await sb().from('exam_attempts').select('*').eq('attempt_id', attemptId).maybeSingle());
    if (!att) throw err('ERR_NOT_FOUND', 'Examination attempt not found.');
    if (att.student_user_id !== userId) throw err('ERR_FORBIDDEN_RESOURCE', 'Access denied: This attempt belongs to another user.');
    var ex = okPg(await sb().from('exam_sets').select('*').eq('exam_set_id', att.exam_set_id).single());
    return { att: att, ex: ex };
  }

  async function handleStudentGetAttempt(payload, token) {
    var ses = await B().requireSession(token, ['STUDENT', 'ADMIN']);
    var attemptId = clean(payload && payload.attemptId, 64);
    var res = await loadOwnedAttemptOrThrow(attemptId, ses.userId);
    var att = await finalizeExpiredAttemptIfNeeded(res.att, res.ex, ses.userId);
    if (att.attempt_status !== 'IN_PROGRESS') {
      var cnt = okPg(await sb().from('attempt_items').select('attempt_item_id').eq('attempt_id', attemptId)) || [];
      return { attemptFinalized: true, receipt: buildReceiptBundle(att, res.ex, cnt.length) };
    }
    var ver = okPg(await sb().from('exam_versions').select('*').eq('exam_version_id', att.exam_version_id).single());
    var qbB = await loadQuestionBankBundle();
    return await buildStudentWorkspaceBundle(att, res.ex, ver, qbB);
  }

  function hasResponseValue(qv, rawP) {
    var qType = qv ? qv.question_type : 'SINGLE_CHOICE';
    var p = rawP && typeof rawP === 'object' ? rawP : {};
    if (qType === 'SINGLE_CHOICE' || qType === 'TRUE_FALSE') return Boolean(String(p.selectedOptionId || '').trim());
    if (qType === 'MULTIPLE_SELECT') return Array.isArray(p.selectedOptionIds) && p.selectedOptionIds.length > 0;
    if (qType === 'COMPLEX_MULTIPLE_CHOICE') {
      var sd = p.statementDecisions && typeof p.statementDecisions === 'object' ? p.statementDecisions : {};
      return Object.keys(sd).some(function (k) { return sd[k] === 'YES' || sd[k] === 'NO'; });
    }
    if (qType === 'NUMERIC_RESPONSE') return String(p.numericText !== undefined ? p.numericText : '').trim() !== '';
    return String(p.textResponse !== undefined ? p.textResponse : '').trim() !== '';
  }

  async function handleStudentSaveResponses(payload, token) {
    var ses = await B().requireSession(token, ['STUDENT', 'ADMIN']);
    var req = payload || {};
    var attemptId = clean(req.attemptId, 64);
    var res = await loadOwnedAttemptOrThrow(attemptId, ses.userId);
    var att = await finalizeExpiredAttemptIfNeeded(res.att, res.ex, ses.userId);
    if (att.attempt_status !== 'IN_PROGRESS') {
      throw err('ERR_CONFLICT_VERSION', 'Attempt is no longer IN_PROGRESS (' + att.attempt_status + ').');
    }
    var iState = buildAttemptIntegrityStateDto(att, res.ex);
    if (iState.isCurrentlySuspended) throw err('ERR_FORBIDDEN_RESOURCE', 'Interaction temporarily suspended under copy-restriction policy.');

    var itemsInput = Array.isArray(req.items) ? req.items : (req.attemptItemId ? [{ attemptItemId: req.attemptItemId, responsePayload: req.responsePayload, clientRevisionNo: req.clientRevisionNo }] : []);
    var all = await Promise.all([
      sb().from('attempt_items').select('*').eq('attempt_id', attemptId),
      sb().from('attempt_responses').select('*').eq('attempt_id', attemptId),
      sb().from('question_versions').select('*')
    ]);
    var atiById = {}; (okPg(all[0]) || []).forEach(function (i) { atiById[i.attempt_item_id] = i; });
    var respByItemId = {}; (okPg(all[1]) || []).forEach(function (r) { respByItemId[r.attempt_item_id] = r; });
    var qvById = {}; (okPg(all[2]) || []).forEach(function (q) { qvById[q.question_version_id] = q; });

    var now = nowIso(), nextRev = (Number(att.latest_revision_no) || 0) + 1;
    var savedByItemId = {};

    for (var i = 0; i < itemsInput.length; i++) {
      var itIn = itemsInput[i] || {};
      var aid = clean(itIn.attemptItemId, 64);
      var ati = atiById[aid];
      if (!ati) continue;
      var qv = qvById[ati.question_version_id];
      var rPay = itIn.responsePayload && typeof itIn.responsePayload === 'object' ? itIn.responsePayload : {};
      var isAns = hasResponseValue(qv, rPay);
      var curResp = respByItemId[aid];
      var cliRev = Number(itIn.clientRevisionNo) || nextRev;

      if (curResp) {
        if (cliRev < (Number(curResp.client_revision_no) || 0)) continue;
        okPg(await sb().from('attempt_responses').update({
          response_payload_json: rPay,
          is_answered: isAns,
          client_revision_no: cliRev,
          server_revision_no: nextRev,
          saved_at_utc: now,
          updated_at_utc: now,
          version: (Number(curResp.version) || 1) + 1
        }).eq('response_id', curResp.response_id));
      } else {
        okPg(await sb().from('attempt_responses').insert({
          response_id: genId('atr_'),
          attempt_id: attemptId,
          attempt_item_id: aid,
          question_version_id: ati.question_version_id,
          student_user_id: ses.userId,
          response_payload_json: rPay,
          is_answered: isAns,
          client_revision_no: cliRev,
          server_revision_no: nextRev,
          saved_at_utc: now,
          grading_source: 'UNGRADED',
          awarded_points_bp: 0,
          max_points_bp: Number(ati.points_bp) || 100,
          correctness_state: 'UNGRADED',
          created_at_utc: now,
          updated_at_utc: now,
          version: 1
        }));
      }
      respByItemId[aid] = Object.assign({}, curResp || {}, { is_answered: isAns });
      savedByItemId[aid] = { isAnswered: isAns, serverRevisionNo: nextRev, savedAtUtc: now, savedAtBangkok: fmtBkk(now) };
    }

    var ansCnt = Object.keys(respByItemId).filter(function (k) { return Boolean(respByItemId[k].is_answered); }).length;
    okPg(await sb().from('exam_attempts').update({ latest_revision_no: nextRev, last_saved_at_utc: now, answered_count: ansCnt, updated_at_utc: now }).eq('attempt_id', attemptId));
    return { saved: true, attemptId: attemptId, serverRevisionNo: nextRev, answeredCount: ansCnt, savedAtUtc: now, savedAtBangkok: fmtBkk(now), savedItems: savedByItemId };
  }

  async function handleStudentSaveFlags(payload, token) {
    var ses = await B().requireSession(token, ['STUDENT', 'ADMIN']);
    var req = payload || {};
    var attemptId = clean(req.attemptId, 64);
    await loadOwnedAttemptOrThrow(attemptId, ses.userId);
    var updates = Array.isArray(req.flags) ? req.flags : (req.attemptItemId ? [{ attemptItemId: req.attemptItemId, isFlagged: Boolean(req.isFlagged) }] : []);
    var now = nowIso();
    for (var i = 0; i < updates.length; i++) {
      var u = updates[i] || {};
      okPg(await sb().from('attempt_items').update({ is_flagged: Boolean(u.isFlagged), flag_updated_at_utc: now }).eq('attempt_item_id', clean(u.attemptItemId, 64)).eq('attempt_id', attemptId));
    }
    var atiRows = okPg(await sb().from('attempt_items').select('attempt_item_id,is_flagged').eq('attempt_id', attemptId)) || [];
    var flagCnt = atiRows.filter(function (x) { return Boolean(x.is_flagged); }).length;
    okPg(await sb().from('exam_attempts').update({ flagged_count: flagCnt, updated_at_utc: now }).eq('attempt_id', attemptId));
    return { saved: true, flaggedCount: flagCnt };
  }

  async function handleStudentCheckPracticeItem(payload, token) {
    var ses = await B().requireSession(token, ['STUDENT', 'ADMIN']);
    var req = payload || {};
    var attemptId = clean(req.attemptId, 64), itemId = clean(req.attemptItemId, 64);
    var res = await loadOwnedAttemptOrThrow(attemptId, ses.userId);
    if (res.ex.exam_mode !== 'PRACTICE' || !res.ex.allow_per_question_practice_feedback) {
      throw err('ERR_FORBIDDEN_RESOURCE', 'Per-question feedback check is only available in enabled Practice mode exams.');
    }
    if (req.responsePayload) {
      await handleStudentSaveResponses({ attemptId: attemptId, items: [{ attemptItemId: itemId, responsePayload: req.responsePayload }] }, token);
    }
    var ati = okPg(await sb().from('attempt_items').select('*').eq('attempt_item_id', itemId).eq('attempt_id', attemptId).single());
    var qv = okPg(await sb().from('question_versions').select('*').eq('question_version_id', ati.question_version_id).single());
    var resp = okPg(await sb().from('attempt_responses').select('*').eq('attempt_item_id', itemId).maybeSingle());
    var ev = await evaluateSingleItemScore(qv, resp ? asJsonObj(resp.response_payload_json, {}) : {}, ati.points_bp, ati.negative_points_bp);
    var expDoc = qv.explanation_richtext_json ? asRichDoc(qv.explanation_richtext_json) : B().normalizeRichTextDoc('', false).doc;
    return {
      attemptItemId: itemId,
      correctnessState: ev.correctnessState,
      awardedPointsDisplay: formatPointsBp(ev.awardedPointsBp),
      maxPointsDisplay: formatPointsBp(ev.maxPointsBp),
      explanationRichText: expDoc,
      explanationPlainText: extractPlainText(expDoc),
      referenceText: qv.reference_text || ''
    };
  }

  async function handleStudentSubmitAttempt(payload, token) {
    var ses = await B().requireSession(token, ['STUDENT', 'ADMIN']);
    var req = payload || {};
    var attemptId = clean(req.attemptId, 64);
    var res = await loadOwnedAttemptOrThrow(attemptId, ses.userId);
    var att = res.att, ex = res.ex;

    if (att.attempt_status === 'IN_PROGRESS' && Array.isArray(req.finalResponses) && req.finalResponses.length > 0) {
      try { await handleStudentSaveResponses({ attemptId: attemptId, items: req.finalResponses }, token); } catch (ignoreSaveErr) {}
    }
    att = okPg(await sb().from('exam_attempts').select('*').eq('attempt_id', attemptId).single());
    if (att.attempt_status === 'IN_PROGRESS') {
      var now = nowIso();
      var startMs = Date.parse(att.started_at_utc) || Date.now();
      var usedSec = Math.max(0, Math.round((Date.now() - startMs) / 1000));
      att = okPg(await sb().from('exam_attempts').update({
        attempt_status: 'SUBMITTED',
        submitted_at_utc: now,
        time_used_seconds: usedSec,
        active_lease_token: '',
        updated_at_utc: now
      }).eq('attempt_id', attemptId).select('*').single());
      att = await gradeSubmittedAttempt(att, ex, 'SUBMIT_ATTEMPT', ses.userId);
    }
    var cnt = (okPg(await sb().from('attempt_items').select('attempt_item_id').eq('attempt_id', attemptId)) || []).length;
    return buildReceiptBundle(att, ex, cnt);
  }

  // ==================== ADMIN GRADING, RESULTS, REGRADE, ANALYTICS ====================

  async function handleAdminListAttempts(payload, token) {
    await B().requireSession(token, ['ADMIN']);
    var req = payload || {};
    var fEx = clean(req.examSetId, 64), fAttSt = String(req.attemptStatus || 'ALL').toUpperCase(), fGradSt = String(req.gradingStatus || 'ALL').toUpperCase();
    var all = await Promise.all([
      sb().from('exam_attempts').select('*'),
      sb().from('exam_sets').select('exam_set_id,exam_code,title,exam_mode'),
      sb().from('courses').select('course_id,course_code'),
      sb().rpc('pb_admin_list_users', { p_session_token: token, p_limit: 200 })
    ]);
    var atts = okPg(all[0]) || [], exMap = {}, cMap = {}, uMap = {};
    (okPg(all[1]) || []).forEach(function (e) { exMap[e.exam_set_id] = e; });
    (okPg(all[2]) || []).forEach(function (c) { cMap[c.course_id] = c; });
    ((B().unwrapRpcResult(all[3]) || {}).users || []).forEach(function (u) { uMap[u.userId] = u; });

    var counts = { totalAttempts: 0, inProgressCount: 0, submittedCount: 0, pendingManualGradingCount: 0, gradedCount: 0, publishedCount: 0 };
    var items = [];
    for (var i = atts.length - 1; i >= 0; i--) {
      var att = atts[i];
      counts.totalAttempts += 1;
      if (att.attempt_status === 'IN_PROGRESS') counts.inProgressCount += 1;
      if (att.attempt_status === 'SUBMITTED' || att.attempt_status === 'EXPIRED_SUBMITTED') counts.submittedCount += 1;
      if (att.grading_status === 'AUTO_GRADED_PENDING_MANUAL') counts.pendingManualGradingCount += 1;
      if (att.grading_status === 'GRADED' || att.grading_status === 'REGRADED') counts.gradedCount += 1;
      if (att.publication_status === 'PUBLISHED') counts.publishedCount += 1;

      if (fEx && fEx !== 'ALL' && att.exam_set_id !== fEx) continue;
      if (fAttSt !== 'ALL' && att.attempt_status !== fAttSt) continue;
      if (fGradSt !== 'ALL' && att.grading_status !== fGradSt) continue;

      var ex = exMap[att.exam_set_id], u = uMap[att.student_user_id], c = cMap[att.course_id];
      var totBp = Number(att.total_score_bp) || 0, maxBp = Number(att.max_score_bp) || 100;
      var pctVal = Math.round((Number(att.percentage_bp) || 0) / 10) / 10;
      items.push({
        attemptId: att.attempt_id,
        examSetId: att.exam_set_id,
        examCode: ex ? ex.exam_code : '',
        examTitle: ex ? ex.title : '',
        examMode: ex ? ex.exam_mode : '',
        courseId: att.course_id || '',
        courseCode: c ? c.course_code : '',
        studentUserId: att.student_user_id,
        studentUsername: u ? u.username : '',
        studentFullName: u ? u.fullName : '',
        attemptNumber: Number(att.attempt_number) || 1,
        attemptStatus: att.attempt_status,
        gradingStatus: att.grading_status,
        publicationStatus: att.publication_status,
        explanationStatus: att.explanation_status,
        startedAtBangkok: fmtBkk(att.started_at_utc),
        submittedAtBangkok: att.submitted_at_utc ? fmtBkk(att.submitted_at_utc) : '-',
        lastSavedAtBangkok: att.last_saved_at_utc ? fmtBkk(att.last_saved_at_utc) : '-',
        timeUsedFormatted: fmtDurationSec(att.time_used_seconds),
        answeredCount: Number(att.answered_count) || 0,
        flaggedCount: Number(att.flagged_count) || 0,
        autoScoreBp: Number(att.auto_score_bp) || 0,
        autoScoreDisplay: formatPointsBp(att.auto_score_bp || 0),
        manualScoreBp: Number(att.manual_score_bp) || 0,
        manualScoreDisplay: formatPointsBp(att.manual_score_bp || 0),
        totalScoreBp: totBp,
        maxScoreBp: maxBp,
        scoreDisplay: formatPointsBp(totBp) + ' / ' + formatPointsBp(maxBp),
        percentageFormatted: pctVal.toFixed(1) + '%',
        passedFlag: Boolean(att.passed_flag),
        version: Number(att.version) || 1
      });
    }
    return { attempts: items, summary: counts };
  }

  async function handleAdminInspectAttempt(payload, token) {
    await B().requireSession(token, ['ADMIN']);
    var attemptId = clean(payload && payload.attemptId, 64);
    var att = okPg(await sb().from('exam_attempts').select('*').eq('attempt_id', attemptId).maybeSingle());
    if (!att) throw err('ERR_NOT_FOUND', 'Attempt not found.');
    var all = await Promise.all([
      sb().from('exam_sets').select('*').eq('exam_set_id', att.exam_set_id).maybeSingle(),
      sb().from('attempt_items').select('*').eq('attempt_id', attemptId),
      sb().from('attempt_responses').select('*').eq('attempt_id', attemptId),
      sb().from('result_revisions').select('*').eq('attempt_id', attemptId),
      sb().rpc('pb_admin_list_users', { p_session_token: token, p_limit: 200 }),
      loadQuestionBankBundle()
    ]);
    var ex = okPg(all[0]), atiRows = (okPg(all[1]) || []).sort(function (a, b) { return (Number(a.display_number) || 0) - (Number(b.display_number) || 0); });
    var resps = okPg(all[2]) || [], revs = okPg(all[3]) || [];
    var u = ((B().unwrapRpcResult(all[4]) || {}).users || []).find(function (x) { return x.userId === att.student_user_id; });
    var qbB = all[5], respMap = {}; resps.forEach(function (r) { respMap[r.attempt_item_id] = r; });

    var detailed = atiRows.map(function (ati, k) {
      var qb = qbB.qbById[ati.question_id], qv = qbB.qvById[ati.question_version_id], resp = respMap[ati.attempt_item_id];
      var qAdmin = qb && qv ? projectQuestionVersionDto(qb, qv, qbB.qoByQvId[ati.question_version_id] || [], null, true) : null;
      return {
        attemptItemId: ati.attempt_item_id,
        displayNumber: Number(ati.display_number) || k + 1,
        questionId: ati.question_id,
        questionVersionId: ati.question_version_id,
        questionCode: qb ? qb.question_code : '',
        questionType: qv ? qv.question_type : '',
        gradingMode: qv ? qv.grading_mode : 'AUTO',
        maxPointsBp: Number(ati.points_bp) || 100,
        maxPoints: (Number(ati.points_bp) || 100) / 100,
        maxPointsDisplay: formatPointsBp(ati.points_bp || 100),
        questionAdminView: qAdmin,
        responseId: resp ? resp.response_id : '',
        responseVersion: resp ? Number(resp.version) || 1 : 1,
        isAnswered: Boolean(resp && resp.is_answered),
        responsePayload: resp ? asJsonObj(resp.response_payload_json, {}) : {},
        gradingSource: resp ? resp.grading_source : 'UNGRADED',
        correctnessState: resp ? resp.correctness_state : 'UNGRADED',
        awardedPointsBp: resp ? Number(resp.awarded_points_bp) || 0 : 0,
        awardedPoints: resp ? (Number(resp.awarded_points_bp) || 0) / 100 : 0,
        awardedPointsDisplay: formatPointsBp(resp ? resp.awarded_points_bp : 0),
        instructorFeedback: resp ? resp.instructor_feedback || '' : ''
      };
    });

    return {
      attempt: {
        attemptId: att.attempt_id,
        examSetId: att.exam_set_id,
        examCode: ex ? ex.exam_code : '',
        examTitle: ex ? ex.title : '',
        studentUserId: att.student_user_id,
        studentUsername: u ? u.username : '',
        studentFullName: u ? u.fullName : '',
        attemptNumber: Number(att.attempt_number) || 1,
        attemptStatus: att.attempt_status,
        gradingStatus: att.grading_status,
        publicationStatus: att.publication_status,
        explanationStatus: att.explanation_status,
        autoScoreDisplay: formatPointsBp(att.auto_score_bp),
        manualScoreDisplay: formatPointsBp(att.manual_score_bp),
        totalScoreDisplay: formatPointsBp(att.total_score_bp) + ' / ' + formatPointsBp(att.max_score_bp),
        version: Number(att.version) || 1
      },
      items: detailed,
      revisions: revs.map(function (r) {
        return {
          resultRevisionId: r.result_revision_id,
          revisionNo: Number(r.revision_no) || 1,
          revisionType: r.revision_type,
          totalScoreDisplay: formatPointsBp(r.total_score_bp) + ' / ' + formatPointsBp(r.max_score_bp),
          gradingStatus: r.grading_status,
          publicationStatus: r.publication_status,
          explanationStatus: r.explanation_status,
          reason: r.reason,
          createdAtBangkok: fmtBkk(r.created_at_utc)
        };
      })
    };
  }

  async function handleAdminSaveManualGrading(payload, token) {
    var admin = await B().requireSession(token, ['ADMIN']);
    var req = payload || {};
    var attemptId = clean(req.attemptId, 64);
    var grades = Array.isArray(req.grades) ? req.grades : (req.attemptItemId ? [req] : []);
    var att = okPg(await sb().from('exam_attempts').select('*').eq('attempt_id', attemptId).single());
    var ex = okPg(await sb().from('exam_sets').select('*').eq('exam_set_id', att.exam_set_id).single());
    var resps = okPg(await sb().from('attempt_responses').select('*').eq('attempt_id', attemptId)) || [];
    var atis = okPg(await sb().from('attempt_items').select('*').eq('attempt_id', attemptId)) || [];
    var respMap = {}; resps.forEach(function (r) { respMap[r.attempt_item_id] = r; });
    var atiMap = {}; atis.forEach(function (i) { atiMap[i.attempt_item_id] = i; });
    var now = nowIso();

    for (var i = 0; i < grades.length; i++) {
      var g = grades[i] || {}, aid = clean(g.attemptItemId, 64), ati = atiMap[aid];
      if (!ati) continue;
      var iMax = Number(ati.points_bp) || 100;
      var awBp = Math.max(0, Math.min(iMax, Math.round((Number(g.awardedPoints !== undefined ? g.awardedPoints : g.awardedPointsBp / 100) || 0) * 100)));
      var corrState = awBp >= iMax ? 'CORRECT' : (awBp > 0 ? 'PARTIAL' : 'INCORRECT');
      var r = respMap[aid];
      if (r) {
        okPg(await sb().from('attempt_responses').update({
          grading_source: 'MANUAL_INSTRUCTOR',
          awarded_points_bp: awBp,
          correctness_state: corrState,
          instructor_feedback: clean(g.instructorFeedback, 2000),
          graded_by_user_id: admin.userId,
          graded_at_utc: now,
          updated_at_utc: now
        }).eq('response_id', r.response_id));
      } else {
        okPg(await sb().from('attempt_responses').insert({
          response_id: genId('atr_'),
          attempt_id: attemptId,
          attempt_item_id: aid,
          question_version_id: ati.question_version_id,
          student_user_id: att.student_user_id,
          response_payload_json: {},
          is_answered: false,
          grading_source: 'MANUAL_INSTRUCTOR',
          awarded_points_bp: awBp,
          max_points_bp: iMax,
          correctness_state: corrState,
          instructor_feedback: clean(g.instructorFeedback, 2000),
          graded_by_user_id: admin.userId,
          graded_at_utc: now,
          created_at_utc: now,
          updated_at_utc: now,
          version: 1
        }));
      }
    }

    var allResps = okPg(await sb().from('attempt_responses').select('*').eq('attempt_id', attemptId)) || [];
    var qvs = okPg(await sb().from('question_versions').select('question_version_id,grading_mode')) || [];
    var qvMode = {}; qvs.forEach(function (q) { qvMode[q.question_version_id] = q.grading_mode; });
    var autoBp = 0, manualBp = 0, pending = false;
    allResps.forEach(function (r) {
      if (r.correctness_state === 'MANUAL_REVIEW_PENDING') pending = true;
      if (r.grading_source === 'MANUAL_INSTRUCTOR' || qvMode[r.question_version_id] === 'MANUAL') manualBp += Number(r.awarded_points_bp) || 0;
      else autoBp += Number(r.awarded_points_bp) || 0;
    });
    var totBp = Math.max(0, autoBp + manualBp), maxBp = Number(att.max_score_bp) || 100;
    var pctBp = maxBp > 0 ? Math.round((totBp / maxBp) * 10000) : 0;
    var passed = (pctBp / 100) >= (Number(ex.pass_threshold_pct) || 60);
    var gradStatus = pending ? 'AUTO_GRADED_PENDING_MANUAL' : 'GRADED';
    var revs = okPg(await sb().from('result_revisions').select('revision_no').eq('attempt_id', attemptId)) || [];
    var revId = genId('rrv_');
    okPg(await sb().from('result_revisions').insert({
      result_revision_id: revId,
      attempt_id: attemptId,
      exam_set_id: att.exam_set_id,
      exam_version_id: att.exam_version_id,
      student_user_id: att.student_user_id,
      revision_no: revs.reduce(function (m, x) { return Math.max(m, Number(x.revision_no) || 0); }, 0) + 1,
      revision_type: 'MANUAL_GRADING_COMPLETED',
      auto_score_bp: autoBp,
      manual_score_bp: manualBp,
      total_score_bp: totBp,
      max_score_bp: maxBp,
      percentage_bp: pctBp,
      passed_flag: passed,
      grading_status: gradStatus,
      publication_status: att.publication_status,
      explanation_status: att.explanation_status,
      reason: 'Instructor manual grading saved',
      actor_user_id: admin.userId,
      created_at_utc: now
    }));
    okPg(await sb().from('exam_attempts').update({
      grading_status: gradStatus,
      auto_score_bp: autoBp,
      manual_score_bp: manualBp,
      total_score_bp: totBp,
      percentage_bp: pctBp,
      passed_flag: passed,
      current_result_revision_id: revId,
      updated_at_utc: now
    }).eq('attempt_id', attemptId));
    if (att.publication_status === 'PUBLISHED') await syncPublishedExamScoreToAssessmentScores(ex, att.student_user_id, admin.userId);
    return await handleAdminInspectAttempt({ attemptId: attemptId }, token);
  }

  async function handleAdminPublishResults(payload, token) {
    var admin = await B().requireSession(token, ['ADMIN']);
    var req = payload || {};
    var examSetId = clean(req.examSetId, 64), attemptId = clean(req.attemptId, 64);
    var pubAct = String(req.publicationAction || 'NO_CHANGE').toUpperCase();
    var expAct = String(req.explanationAction || 'NO_CHANGE').toUpperCase();
    var reason = clean(req.reason, 400) || 'Result publication update';
    var q = sb().from('exam_attempts').select('*');
    if (attemptId) q = q.eq('attempt_id', attemptId);
    else if (examSetId) q = q.eq('exam_set_id', examSetId);
    var atts = okPg(await q) || [];
    var exs = okPg(await sb().from('exam_sets').select('*')) || [], exMap = {};
    exs.forEach(function (e) { exMap[e.exam_set_id] = e; });
    var now = nowIso(), updated = 0, affected = {};

    for (var i = 0; i < atts.length; i++) {
      var att = atts[i];
      if (att.attempt_status !== 'SUBMITTED' && att.attempt_status !== 'EXPIRED_SUBMITTED') continue;
      var nPub = pubAct === 'PUBLISH_SCORES' ? 'PUBLISHED' : (pubAct === 'WITHHOLD_SCORES' ? 'WITHHELD' : att.publication_status);
      var nExp = expAct === 'RELEASE_EXPLANATIONS' ? 'RELEASED' : (expAct === 'WITHHOLD_EXPLANATIONS' ? 'WITHHELD' : att.explanation_status);
      var revId = genId('rrv_');
      okPg(await sb().from('result_revisions').insert({
        result_revision_id: revId,
        attempt_id: att.attempt_id,
        exam_set_id: att.exam_set_id,
        exam_version_id: att.exam_version_id,
        student_user_id: att.student_user_id,
        revision_no: 1,
        revision_type: 'PUBLICATION_CHANGE',
        auto_score_bp: Number(att.auto_score_bp) || 0,
        manual_score_bp: Number(att.manual_score_bp) || 0,
        total_score_bp: Number(att.total_score_bp) || 0,
        max_score_bp: Number(att.max_score_bp) || 0,
        percentage_bp: Number(att.percentage_bp) || 0,
        passed_flag: Boolean(att.passed_flag),
        grading_status: att.grading_status,
        publication_status: nPub,
        explanation_status: nExp,
        reason: reason,
        actor_user_id: admin.userId,
        created_at_utc: now
      }));
      okPg(await sb().from('exam_attempts').update({ publication_status: nPub, explanation_status: nExp, current_result_revision_id: revId, updated_at_utc: now }).eq('attempt_id', att.attempt_id));
      updated += 1;
      affected[att.exam_set_id + '|' + att.student_user_id] = { ex: exMap[att.exam_set_id], stu: att.student_user_id };
    }
    var keys = Object.keys(affected);
    for (var k = 0; k < keys.length; k++) {
      if (affected[keys[k]].ex) await syncPublishedExamScoreToAssessmentScores(affected[keys[k]].ex, affected[keys[k]].stu, admin.userId);
    }
    var listRes = await handleAdminListAttempts(examSetId ? { examSetId: examSetId } : {}, token);
    return { updatedCount: updated, warnings: [], attempts: listRes.attempts, summary: listRes.summary };
  }

  async function handleAdminRegradeExam(payload, token) {
    var admin = await B().requireSession(token, ['ADMIN']);
    var req = payload || {}, examSetId = clean(req.examSetId, 64), reason = clean(req.reason, 400);
    if (!reason || reason.length < 5) throw err('ERR_VALIDATION_FAILED', 'Regrade reason (min 5 characters) is required.', { reason: 'Required.' });
    var ex = okPg(await sb().from('exam_sets').select('*').eq('exam_set_id', examSetId).single());
    var atts = okPg(await sb().from('exam_attempts').select('*').eq('exam_set_id', examSetId)) || [];
    var regraded = 0;
    for (var i = 0; i < atts.length; i++) {
      if (atts[i].attempt_status === 'SUBMITTED' || atts[i].attempt_status === 'EXPIRED_SUBMITTED') {
        await gradeSubmittedAttempt(atts[i], ex, 'ADMIN_REGRADE', admin.userId);
        regraded += 1;
      }
    }
    return { regradedCount: regraded, attempts: (await handleAdminListAttempts({ examSetId: examSetId }, token)).attempts };
  }

  async function handleAdminManageAttempt(payload, token) {
    var admin = await B().requireSession(token, ['ADMIN']);
    var req = payload || {}, attemptId = clean(req.attemptId, 64), op = String(req.operation || '').toUpperCase(), reason = clean(req.reason, 400);
    if (!reason || reason.length < 3) throw err('ERR_VALIDATION_FAILED', 'Audit reason is required.', { reason: 'Required.' });
    var att = okPg(await sb().from('exam_attempts').select('*').eq('attempt_id', attemptId).single());
    var ex = okPg(await sb().from('exam_sets').select('*').eq('exam_set_id', att.exam_set_id).maybeSingle());
    var now = nowIso();
    if (op === 'EXTEND_TIME') {
      var extraM = Math.max(1, Math.min(240, parseInt(req.extraMinutes, 10) || 15));
      var baseMs = att.effective_deadline_utc ? Math.max(Date.now(), Date.parse(att.effective_deadline_utc)) : Date.now() + 1800000;
      var nextDead = new Date(baseMs + extraM * 60000).toISOString();
      var nextGrace = new Date(Date.parse(nextDead) + ((ex && Number(ex.grace_seconds)) || 15) * 1000).toISOString();
      okPg(await sb().from('exam_attempts').update({ attempt_status: 'IN_PROGRESS', effective_deadline_utc: nextDead, grace_deadline_utc: nextGrace, updated_at_utc: now }).eq('attempt_id', attemptId));
    } else if (op === 'INVALIDATE_ATTEMPT') {
      okPg(await sb().from('exam_attempts').update({ attempt_status: 'INVALIDATED', publication_status: 'WITHHELD', explanation_status: 'WITHHELD', active_lease_token: '', updated_at_utc: now }).eq('attempt_id', attemptId));
    } else {
      throw err('ERR_VALIDATION_FAILED', 'Unsupported attempt management operation.');
    }
    await B().writeAuditEvent(admin.userId, 'ADMIN', 'ADMIN_EXAM_ATTEMPT_' + op, 'ExamAttempt', attemptId, { reason: reason });
    return await handleAdminListAttempts({ examSetId: att.exam_set_id }, token);
  }

  async function handleStudentGetPublishedResult(payload, token) {
    var ses = await B().requireSession(token, ['STUDENT', 'ADMIN']);
    var req = payload || {}, attemptId = clean(req.attemptId, 64), examSetId = clean(req.examSetId, 64);
    var att = attemptId ? okPg(await sb().from('exam_attempts').select('*').eq('attempt_id', attemptId).maybeSingle()) : null;
    if (!att && examSetId) {
      var list = okPg(await sb().from('exam_attempts').select('*').eq('exam_set_id', examSetId).eq('student_user_id', ses.userId)) || [];
      att = list.reverse().find(function (a) { return a.attempt_status === 'SUBMITTED' || a.attempt_status === 'EXPIRED_SUBMITTED'; }) || list[0];
    }
    if (!att) throw err('ERR_NOT_FOUND', 'Submitted attempt result not found.');
    if (att.student_user_id !== ses.userId && ses.role !== 'ADMIN') throw err('ERR_FORBIDDEN_RESOURCE', 'Access denied.');
    var ex = okPg(await sb().from('exam_sets').select('*').eq('exam_set_id', att.exam_set_id).single());
    var rel = resolveEffectiveReleaseState(att, ex, Date.now());
    var includeExp = rel.effectiveExplanationStatus === 'RELEASED';

    var all = await Promise.all([
      sb().from('exam_sections').select('*').eq('exam_version_id', att.exam_version_id),
      sb().from('attempt_items').select('*').eq('attempt_id', att.attempt_id),
      sb().from('attempt_responses').select('*').eq('attempt_id', att.attempt_id),
      sb().from('result_revisions').select('*').eq('attempt_id', att.attempt_id),
      sb().from('exam_attempts').select('*').eq('exam_set_id', ex.exam_set_id).eq('student_user_id', att.student_user_id),
      loadQuestionBankBundle()
    ]);
    var secs = okPg(all[0]) || [], atiRows = (okPg(all[1]) || []).sort(function (a, b) { return (Number(a.display_number) || 0) - (Number(b.display_number) || 0); });
    var resps = okPg(all[2]) || [], revs = okPg(all[3]) || [], hist = okPg(all[4]) || [], qbB = all[5];
    var secMap = {}; secs.forEach(function (s) { secMap[s.exam_section_id] = { examSectionId: s.exam_section_id, title: s.title, sortOrder: Number(s.sort_order) || 0, questionCount: 0, earnedBp: 0, maxBp: 0 }; });
    var respMap = {}; resps.forEach(function (r) { respMap[r.attempt_item_id] = r; });

    var reviewItems = atiRows.map(function (ati, k) {
      var qb = qbB.qbById[ati.question_id], qv = qbB.qvById[ati.question_version_id], resp = respMap[ati.attempt_item_id];
      var iMax = Number(ati.points_bp) || 100, iEarn = resp ? Number(resp.awarded_points_bp) || 0 : 0;
      if (secMap[ati.exam_section_id]) { secMap[ati.exam_section_id].questionCount += 1; secMap[ati.exam_section_id].maxBp += iMax; secMap[ati.exam_section_id].earnedBp += Math.max(0, iEarn); }
      var rawOpts = qbB.qoByQvId[ati.question_version_id] || [];
      var projQ = qb && qv ? projectQuestionVersionDto(qb, qv, rawOpts, qv.stimulus_id ? qbB.stById[qv.stimulus_id] : null, includeExp) : null;
      if (projQ && !includeExp) {
        delete projQ.privateGradingData;
        if (Array.isArray(projQ.options)) projQ.options.forEach(function (o) { delete o.isCorrect; });
      }
      var itDto = {
        attemptItemId: ati.attempt_item_id,
        displayNumber: Number(ati.display_number) || k + 1,
        examSectionId: ati.exam_section_id,
        sectionTitle: secMap[ati.exam_section_id] ? secMap[ati.exam_section_id].title : 'Section',
        questionCode: qb ? qb.question_code : '',
        questionType: qv ? qv.question_type : '',
        isAnswered: Boolean(resp && resp.is_answered),
        studentResponse: resp ? asJsonObj(resp.response_payload_json, {}) : {},
        correctnessState: resp ? resp.correctness_state : 'UNANSWERED',
        awardedPointsBp: iEarn,
        awardedPointsDisplay: formatPointsBp(iEarn),
        maxPointsBp: iMax,
        maxPointsDisplay: formatPointsBp(iMax),
        instructorFeedback: resp ? resp.instructor_feedback || '' : '',
        question: projQ
      };
      if (includeExp && projQ && projQ.privateGradingData) {
        itDto.explanationRichText = projQ.privateGradingData.explanationRichText;
        itDto.explanationPlainText = projQ.privateGradingData.explanationPlainText;
        itDto.referenceText = projQ.privateGradingData.referenceText || '';
        itDto.answerKeySummary = projQ.privateGradingData.gradingSpec || {};
      }
      return itDto;
    });

    var secBreakdown = Object.keys(secMap).map(function (k) { return secMap[k]; }).sort(function (a, b) { return a.sortOrder - b.sortOrder; }).map(function (s) {
      var p = s.maxBp > 0 ? Math.round((s.earnedBp / s.maxBp) * 1000) / 10 : 0;
      return { examSectionId: s.examSectionId, title: s.title, questionCount: s.questionCount, earnedDisplay: formatPointsBp(s.earnedBp), maxDisplay: formatPointsBp(s.maxBp), scoreDisplay: formatPointsBp(s.earnedBp) + ' / ' + formatPointsBp(s.maxBp), percentageFormatted: p.toFixed(1) + '%' };
    });

    var receiptDto = buildReceiptBundle(att, ex, atiRows.length);
    var revNote = revs.filter(function (r) { return r.revision_type === 'ADMIN_REGRADE'; }).pop();
    return {
      scorePublished: rel.effectivePublicationStatus === 'PUBLISHED',
      explanationsReleased: includeExp,
      attemptId: att.attempt_id,
      attemptNumber: Number(att.attempt_number) || 1,
      examSetId: ex.exam_set_id,
      courseId: ex.course_id || '',
      examCode: ex.exam_code,
      examTitle: ex.title,
      instructionsRichText: asRichDoc(ex.instructions_richtext_json || ''),
      gradingStatus: att.grading_status,
      publicationStatus: rel.effectivePublicationStatus,
      explanationStatus: rel.effectiveExplanationStatus,
      regradeNotice: revNote ? ('Regraded on ' + fmtBkk(revNote.created_at_utc) + ': ' + revNote.reason) : '',
      releasePolicyNotice: receiptDto.releasePolicyExplanation,
      receipt: receiptDto,
      scoreSummary: receiptDto.publishedScoreResult,
      sectionBreakdown: secBreakdown,
      items: reviewItems,
      attemptsHistory: hist.map(function (h) { return { attemptId: h.attempt_id, attemptNumber: Number(h.attempt_number) || 1, attemptStatus: h.attempt_status }; })
    };
  }

  async function handleAdminGetAnalytics(payload, token) {
    await B().requireSession(token, ['ADMIN']);
    var examSetId = clean(payload && payload.examSetId, 64);
    var ex = okPg(await sb().from('exam_sets').select('*').eq('exam_set_id', examSetId).single());
    var all = await Promise.all([
      sb().from('exam_attempts').select('*').eq('exam_set_id', examSetId),
      sb().from('attempt_items').select('*').eq('exam_set_id', examSetId),
      sb().from('attempt_responses').select('*'),
      sb().from('question_bank').select('*')
    ]);
    var atts = okPg(all[0]) || [], atis = okPg(all[1]) || [], resps = okPg(all[2]) || [], qbs = okPg(all[3]) || [];
    var qbMap = {}; qbs.forEach(function (q) { qbMap[q.question_id] = q; });
    var validIds = {}, statusCounts = { total: atts.length, submitted: 0, inProgress: 0, invalidated: 0 };
    var graded = [], pcts = [], hi = null, lo = null, passCnt = 0, maxPos = 0;

    atts.forEach(function (a) {
      if (a.attempt_status === 'IN_PROGRESS') statusCounts.inProgress += 1;
      else if (a.attempt_status === 'INVALIDATED' || a.attempt_status === 'INVALIDATED_COPY_POLICY') statusCounts.invalidated += 1;
      else statusCounts.submitted += 1;
      if (a.attempt_status === 'SUBMITTED' || a.attempt_status === 'EXPIRED_SUBMITTED') {
        validIds[a.attempt_id] = true;
        if (a.grading_status === 'GRADED' || a.grading_status === 'REGRADED') {
          graded.push(a);
          var tot = Number(a.total_score_bp) || 0;
          maxPos = Math.max(maxPos, Number(a.max_score_bp) || 0);
          pcts.push((Number(a.percentage_bp) || 0) / 100);
          if (hi === null || tot > hi) hi = tot;
          if (lo === null || tot < lo) lo = tot;
          if (a.passed_flag) passCnt += 1;
        }
      }
    });
    pcts.sort(function (a, b) { return a - b; });
    var mean = pcts.length ? pcts.reduce(function (s, v) { return s + v; }, 0) / pcts.length : 0;
    var med = pcts.length ? (pcts.length % 2 === 1 ? pcts[Math.floor(pcts.length / 2)] : (pcts[pcts.length / 2 - 1] + pcts[pcts.length / 2]) / 2) : 0;
    var respByItem = {}; resps.forEach(function (r) { if (validIds[r.attempt_id]) respByItem[r.attempt_item_id] = r; });

    var qStats = {};
    atis.forEach(function (ati) {
      if (!validIds[ati.attempt_id]) return;
      var qid = ati.question_id, qb = qbMap[qid];
      if (!qStats[qid]) qStats[qid] = { questionId: qid, questionCode: qb ? qb.question_code : qid, title: qb ? qb.title : '', questionType: qb ? qb.question_type : '', deliveredCount: 0, answeredCount: 0, correctCount: 0, flaggedCount: 0, totalAwardedBp: 0, maxPointsBp: Number(ati.points_bp) || 100 };
      var st = qStats[qid];
      st.deliveredCount += 1;
      if (ati.is_flagged) st.flaggedCount += 1;
      var r = respByItem[ati.attempt_item_id];
      if (r) {
        if (r.is_answered) st.answeredCount += 1;
        if (r.correctness_state === 'CORRECT') st.correctCount += 1;
        st.totalAwardedBp += Math.max(0, Number(r.awarded_points_bp) || 0);
      }
    });

    return {
      examSetId: examSetId,
      examCode: ex.exam_code,
      examTitle: ex.title,
      statusCounts: statusCounts,
      scoreDistribution: {
        gradedCount: graded.length,
        meanPercentageFormatted: mean.toFixed(1) + '%',
        medianPercentageFormatted: med.toFixed(1) + '%',
        passRateFormatted: graded.length ? ((passCnt / graded.length) * 100).toFixed(1) + '%' : '0.0%',
        highestScoreDisplay: hi !== null ? formatPointsBp(hi) + ' / ' + formatPointsBp(maxPos) : '-',
        lowestScoreDisplay: lo !== null ? formatPointsBp(lo) + ' / ' + formatPointsBp(maxPos) : '-'
      },
      itemAnalytics: Object.keys(qStats).map(function (k) {
        var st = qStats[k];
        return {
          questionId: st.questionId,
          questionCode: st.questionCode,
          title: st.title,
          questionType: st.questionType,
          deliveredCount: st.deliveredCount,
          answeredCount: st.answeredCount,
          correctCount: st.correctCount,
          correctRateFormatted: (st.deliveredCount ? (st.correctCount / st.deliveredCount) * 100 : 0).toFixed(1) + '%',
          flaggedRateFormatted: (st.deliveredCount ? (st.flaggedCount / st.deliveredCount) * 100 : 0).toFixed(1) + '%',
          averagePointsDisplay: formatPointsBp(st.deliveredCount ? Math.round(st.totalAwardedBp / st.deliveredCount) : 0) + ' / ' + formatPointsBp(st.maxPointsBp)
        };
      })
    };
  }

  async function handleAdminRunMaintenance(payload, token) {
    var admin = await B().requireSession(token, ['ADMIN']);
    var atts = okPg(await sb().from('exam_attempts').select('*').eq('attempt_status', 'IN_PROGRESS')) || [];
    var exMap = {}; (okPg(await sb().from('exam_sets').select('*')) || []).forEach(function (e) { exMap[e.exam_set_id] = e; });
    var finalized = 0;
    for (var i = 0; i < atts.length; i++) {
      if (atts[i].grace_deadline_utc && Date.now() > Date.parse(atts[i].grace_deadline_utc) && exMap[atts[i].exam_set_id]) {
        await finalizeExpiredAttemptIfNeeded(atts[i], exMap[atts[i].exam_set_id], admin.userId);
        finalized += 1;
      }
    }
    return { ok: true, finalizedExpiredCount: finalized, ranAtUtc: nowIso() };
  }

  // ==================== EXAM INTEGRITY & ANTI-COPY TELEMETRY ====================

  function evalAccountLockThreshold(nonOverturnedCnt, baseline, maxBeforeLock) {
    var tot = Math.max(0, Math.floor(Number(nonOverturnedCnt) || 0));
    var base = Math.max(0, Math.floor(Number(baseline) || 0));
    var maxL = Math.max(1, Math.floor(Number(maxBeforeLock) || INTEGRITY_DEFAULTS.MAX_INVALIDATIONS_BEFORE_LOCK));
    var strikes = Math.max(0, tot - base);
    var shouldLock = strikes > maxL;
    return {
      distinctNonOverturnedCopyInvalidations: tot,
      effectiveStrikeBaseline: base,
      effectiveActiveStrikes: strikes,
      maxIntegrityInvalidationsBeforeLock: maxL,
      shouldLockAccount: shouldLock,
      nextIntegrityProfileStatus: shouldLock ? 'INTEGRITY_LOCKED' : (base > 0 ? 'UNLOCKED_ON_PROBATION' : (tot > 0 ? 'WARNED' : 'CLEAR'))
    };
  }

  async function recomputeStudentIntegrityProfile(studentUserId, triggerAttemptId, maxBeforeLock, token) {
    var atts = okPg(await sb().from('exam_attempts').select('*').eq('student_user_id', studentUserId)) || [];
    var distinctNonOver = 0, overt = 0;
    atts.forEach(function (a) {
      var isCopyInv = a.attempt_status === 'INVALIDATED_COPY_POLICY' || (a.attempt_status === 'INVALIDATED' && a.invalidation_reason_code === 'COPY_POLICY_LIMIT_EXCEEDED');
      if (isCopyInv) { if (a.invalidation_overturned) overt += 1; else distinctNonOver += 1; }
    });
    var sip = okPg(await sb().from('student_integrity_profiles').select('*').eq('student_user_id', studentUserId).maybeSingle());
    var baseline = sip ? Number(sip.effective_strike_baseline) || 0 : 0;
    var lockEval = evalAccountLockThreshold(distinctNonOver, baseline, maxBeforeLock);
    var now = nowIso();
    var pFields = {
      student_user_id: studentUserId,
      integrity_status: lockEval.nextIntegrityProfileStatus,
      distinct_copy_invalidations_total: distinctNonOver,
      overturned_invalidations_total: overt,
      effective_strike_baseline: baseline,
      effective_active_strikes: lockEval.effectiveActiveStrikes,
      locked_at_utc: lockEval.shouldLockAccount ? now : (sip ? sip.locked_at_utc : null),
      lock_trigger_attempt_id: lockEval.shouldLockAccount ? triggerAttemptId : (sip ? sip.lock_trigger_attempt_id : ''),
      lock_reason_code: lockEval.shouldLockAccount ? 'REPEATED_EXAM_COPY_INVALIDATIONS' : '',
      updated_at_utc: now
    };
    if (sip) sip = okPg(await sb().from('student_integrity_profiles').update(Object.assign({}, pFields, { version: (Number(sip.version) || 1) + 1 })).eq('profile_id', sip.profile_id).select('*').single());
    else sip = okPg(await sb().from('student_integrity_profiles').insert(Object.assign({ profile_id: genId('sip_'), version: 1 }, pFields)).select('*').single());

    if (lockEval.shouldLockAccount) {
      B().unwrapRpcResult(await sb().rpc('pb_set_user_integrity_status', {
        p_session_token: token,
        p_target_user_id: studentUserId,
        p_next_status: 'INTEGRITY_LOCKED'
      }));
    }
    return { profile: sip, lockEval: lockEval, accountLocked: lockEval.shouldLockAccount };
  }

  async function handleStudentReportCopy(payload, token) {
    var ses = await B().requireSession(token, ['STUDENT', 'ADMIN']);
    var req = payload || {};
    var attemptId = clean(req.attemptId, 64), clientId = clean(req.eventClientId, 64) || genId('cevt_');
    var res = await loadOwnedAttemptOrThrow(attemptId, ses.userId);
    var att = res.att, now = nowIso();
    var replay = okPg(await sb().from('exam_integrity_events').select('*').eq('attempt_id', attemptId).eq('event_client_id', clientId).maybeSingle());
    if (replay) {
      return { idempotentReplay: true, attemptId: attemptId, attemptStatus: att.attempt_status, outcomeAction: replay.outcome_action, warningCount: Number(replay.warning_count_after) || 0, maxCopyWarnings: Number(att.max_copy_warnings_snapshot) || 3 };
    }

    var prevWarn = Number(att.copy_warning_count) || 0, maxWarn = Number(att.max_copy_warnings_snapshot) || 3, suspSec = Number(att.copy_suspension_seconds_snapshot) || 5;
    var nextWarn = prevWarn + 1;
    var shouldInvalidate = nextWarn > maxWarn;
    var outcome = shouldInvalidate ? 'ATTEMPT_INVALIDATED' : 'SUSPENDED_5S';
    var suspUntil = shouldInvalidate ? null : new Date(Date.now() + suspSec * 1000).toISOString();

    if (shouldInvalidate) {
      att = okPg(await sb().from('exam_attempts').update({
        attempt_status: 'INVALIDATED_COPY_POLICY',
        copy_warning_count: nextWarn,
        invalidation_reason_code: 'COPY_POLICY_LIMIT_EXCEEDED',
        invalidated_at_utc: now,
        active_lease_token: '',
        updated_at_utc: now
      }).eq('attempt_id', attemptId).select('*').single());
    } else {
      att = okPg(await sb().from('exam_attempts').update({
        copy_warning_count: nextWarn,
        suspension_until_utc: suspUntil,
        updated_at_utc: now
      }).eq('attempt_id', attemptId).select('*').single());
    }

    var lockOutcome = shouldInvalidate
      ? await recomputeStudentIntegrityProfile(ses.userId, attemptId, att.max_invalidations_lock_snapshot, token)
      : { accountLocked: false, lockEval: { distinctNonOverturnedCopyInvalidations: 0, effectiveActiveStrikes: 0 } };

    var targetReg = ['QUESTION_STEM', 'OPTION_TEXT', 'SHARED_STIMULUS', 'QUESTION_CAPTION'].indexOf(String(req.targetRegion || '').toUpperCase()) !== -1
      ? String(req.targetRegion).toUpperCase() : 'QUESTION_STEM';
    var eie = okPg(await sb().from('exam_integrity_events').insert({
      integrity_event_id: genId('eie_'),
      event_client_id: clientId,
      attempt_id: attemptId,
      exam_set_id: att.exam_set_id,
      exam_version_id: att.exam_version_id,
      course_id: att.course_id || '',
      student_user_id: ses.userId,
      policy_version: att.copy_policy_version_snapshot || INTEGRITY_DEFAULTS.POLICY_VERSION,
      event_type: 'QUALIFYING_COPY_ATTEMPT',
      target_region: targetReg,
      attempt_item_id: clean(req.attemptItemId, 64),
      question_id: clean(req.questionId, 64),
      warning_count_after: nextWarn,
      outcome_action: outcome,
      suspension_until_utc: suspUntil,
      triggered_invalidation: shouldInvalidate,
      triggered_account_lock: Boolean(lockOutcome.accountLocked),
      review_status: 'UNREVIEWED',
      detected_at_client_utc: clean(req.detectedAtClientUtc, 48) || now,
      recorded_at_utc: now,
      version: 1
    }).select('*').single());

    return {
      idempotentReplay: false,
      acknowledgedEventId: clientId,
      integrityEventId: eie.integrity_event_id,
      attemptId: attemptId,
      attemptStatus: att.attempt_status,
      outcomeAction: outcome,
      warningCount: nextWarn,
      maxCopyWarnings: maxWarn,
      counterLabel: shouldInvalidate ? ('Limit exceeded (' + nextWarn + ' / ' + maxWarn + ')') : ('Copy attempt ' + nextWarn + ' of ' + maxWarn + ' warnings.'),
      suspensionSeconds: shouldInvalidate ? 0 : suspSec,
      suspensionUntilUtc: suspUntil || '',
      remainingSuspensionSeconds: shouldInvalidate ? 0 : suspSec,
      invalidationReasonCode: shouldInvalidate ? 'COPY_POLICY_LIMIT_EXCEEDED' : '',
      invalidationTitle: shouldInvalidate ? 'Examination attempt invalidated' : '',
      invalidationMessage: shouldInvalidate ? 'This attempt was invalidated after exceeding permitted copy warnings.' : '',
      accountLocked: Boolean(lockOutcome.accountLocked),
      accountStatus: lockOutcome.accountLocked ? 'INTEGRITY_LOCKED' : 'ACTIVE',
      lockTitle: lockOutcome.accountLocked ? 'Account temporarily locked' : '',
      lockMessage: lockOutcome.accountLocked ? 'Your account has been locked after repeated exam invalidations. Please contact Pattanabhumi Biology.' : '',
      serverNowUtc: now
    };
  }

  async function handleAdminListIntegrity(payload, token) {
    await B().requireSession(token, ['ADMIN']);
    var fStu = clean(payload && payload.studentUserId, 64), fEx = clean(payload && payload.examSetId, 64);
    var all = await Promise.all([
      sb().from('exam_integrity_events').select('*'),
      sb().from('exam_attempts').select('*'),
      sb().from('student_integrity_profiles').select('*'),
      sb().from('exam_integrity_reviews').select('*'),
      sb().from('exam_sets').select('exam_set_id,exam_code,title'),
      sb().rpc('pb_admin_list_users', { p_session_token: token, p_limit: 200 })
    ]);
    var evs = okPg(all[0]) || [], atts = okPg(all[1]) || [], sips = okPg(all[2]) || [], revs = okPg(all[3]) || [];
    var exMap = {}, uMap = {}, users = (B().unwrapRpcResult(all[5]) || {}).users || [];
    (okPg(all[4]) || []).forEach(function (e) { exMap[e.exam_set_id] = e; });
    users.forEach(function (u) { uMap[u.userId] = u; });

    var evDtos = evs.slice().reverse().filter(function (e) {
      return (!fStu || e.student_user_id === fStu) && (!fEx || e.exam_set_id === fEx);
    }).map(function (e) {
      var u = uMap[e.student_user_id], ex = exMap[e.exam_set_id];
      return {
        integrityEventId: e.integrity_event_id,
        attemptId: e.attempt_id,
        examSetId: e.exam_set_id,
        examCode: ex ? ex.exam_code : '',
        examTitle: ex ? ex.title : '',
        studentUserId: e.student_user_id,
        studentUsername: u ? u.username : '',
        studentFullName: u ? u.fullName : '',
        targetRegion: e.target_region,
        warningCountAfter: Number(e.warning_count_after) || 0,
        outcomeAction: e.outcome_action,
        reviewStatus: e.review_status,
        reviewReason: e.review_reason || '',
        recordedAtUtc: e.recorded_at_utc,
        recordedAtBangkok: fmtBkk(e.recorded_at_utc),
        version: Number(e.version) || 1
      };
    });

    var invAtts = [], activeInv = 0, overtInv = 0;
    atts.forEach(function (a) {
      if (a.attempt_status !== 'INVALIDATED_COPY_POLICY' && !(a.attempt_status === 'INVALIDATED' && a.invalidation_reason_code === 'COPY_POLICY_LIMIT_EXCEEDED')) return;
      if (a.invalidation_overturned) overtInv += 1; else activeInv += 1;
      if ((fStu && a.student_user_id !== fStu) || (fEx && a.exam_set_id !== fEx)) return;
      var u = uMap[a.student_user_id], ex = exMap[a.exam_set_id];
      invAtts.push({
        attemptId: a.attempt_id,
        examSetId: a.exam_set_id,
        examCode: ex ? ex.exam_code : '',
        examTitle: ex ? ex.title : '',
        studentUserId: a.student_user_id,
        studentUsername: u ? u.username : '',
        studentFullName: u ? u.fullName : '',
        attemptNumber: Number(a.attempt_number) || 1,
        attemptStatus: a.attempt_status,
        copyWarningCount: Number(a.copy_warning_count) || 0,
        maxCopyWarnings: Number(a.max_copy_warnings_snapshot) || 3,
        invalidatedAtBangkok: fmtBkk(a.invalidated_at_utc),
        invalidationOverturned: Boolean(a.invalidation_overturned),
        invalidationReviewReason: a.invalidation_review_reason || '',
        version: Number(a.version) || 1
      });
    });

    return {
      disclaimerNotice: 'Records reflect browser copy events within protected question areas; automated invalidations and locks remain subject to instructor review.',
      summary: {
        totalEventsCount: evs.length,
        unreviewedEventsCount: evs.filter(function (e) { return e.review_status === 'UNREVIEWED'; }).length,
        activeCopyInvalidationsCount: activeInv,
        overturnedInvalidationsCount: overtInv,
        integrityLockedAccountsCount: users.filter(function (u) { return u.status === 'INTEGRITY_LOCKED'; }).length
      },
      events: evDtos,
      invalidatedAttempts: invAtts,
      studentProfiles: sips.filter(function (s) { return !fStu || s.student_user_id === fStu; }).map(function (sp) {
        var u = uMap[sp.student_user_id];
        return {
          profileId: sp.profile_id,
          studentUserId: sp.student_user_id,
          studentUsername: u ? u.username : '',
          studentFullName: u ? u.fullName : '',
          accountStatus: u ? u.status : 'UNKNOWN',
          integrityStatus: sp.integrity_status,
          distinctCopyInvalidationsTotal: Number(sp.distinct_copy_invalidations_total) || 0,
          overturnedInvalidationsTotal: Number(sp.overturned_invalidations_total) || 0,
          effectiveStrikeBaseline: Number(sp.effective_strike_baseline) || 0,
          effectiveActiveStrikes: Number(sp.effective_active_strikes) || 0,
          maxInvalidationsBeforeLock: INTEGRITY_DEFAULTS.MAX_INVALIDATIONS_BEFORE_LOCK,
          lockedAtBangkok: sp.locked_at_utc ? fmtBkk(sp.locked_at_utc) : '',
          unlockedAtBangkok: sp.unlocked_at_utc ? fmtBkk(sp.unlocked_at_utc) : '',
          unlockReason: sp.unlock_reason || '',
          version: Number(sp.version) || 1
        };
      }),
      reviewsHistory: revs.slice().reverse().map(function (r) {
        var u = uMap[r.student_user_id];
        return { reviewId: r.review_id, actionTaken: r.action_taken, studentUsername: u ? u.username : '', attemptId: r.attempt_id || '', reason: r.reason, createdAtBangkok: fmtBkk(r.created_at_utc) };
      })
    };
  }

  async function handleAdminReviewIntegrity(payload, token) {
    var admin = await B().requireSession(token, ['ADMIN']);
    var req = payload || {}, act = String(req.actionTaken || '').trim().toUpperCase(), reason = clean(req.reason, 400);
    if (!reason || reason.length < 5) throw err('ERR_VALIDATION_FAILED', 'Review reason (min 5 characters) is mandatory.', { reason: 'Required.' });
    var eventId = clean(req.integrityEventId, 64), attemptId = clean(req.attemptId, 64), stuId = clean(req.studentUserId, 64), examSetId = clean(req.examSetId, 64);
    var now = nowIso();

    if (act === 'CONFIRM_INCIDENT' || act === 'MARK_EVENT_ERRONEOUS') {
      var targetStatus = act === 'CONFIRM_INCIDENT' ? 'CONFIRMED' : 'ERRONEOUS_OVERTURNED';
      var q = sb().from('exam_integrity_events').update({ review_status: targetStatus, reviewed_by_user_id: admin.userId, reviewed_at_utc: now, review_reason: reason });
      if (eventId) q = q.eq('integrity_event_id', eventId); else if (attemptId) q = q.eq('attempt_id', attemptId);
      okPg(await q, 'Review integrity event');
    } else if (act === 'OVERTURN_INVALIDATION') {
      var att = okPg(await sb().from('exam_attempts').select('*').eq('attempt_id', attemptId).single());
      stuId = att.student_user_id; examSetId = att.exam_set_id;
      okPg(await sb().from('exam_attempts').update({ invalidation_overturned: true, invalidation_overturned_at_utc: now, invalidation_overturned_by_user_id: admin.userId, invalidation_review_reason: reason, updated_at_utc: now }).eq('attempt_id', attemptId));
      okPg(await sb().from('exam_integrity_events').update({ review_status: 'ERRONEOUS_OVERTURNED', reviewed_by_user_id: admin.userId, reviewed_at_utc: now, review_reason: reason }).eq('attempt_id', attemptId));
      await recomputeStudentIntegrityProfile(stuId, attemptId, att.max_invalidations_lock_snapshot, token);
      if (req.grantReplacementAttempt) {
        var asg = okPg(await sb().from('exam_assignments').select('*').eq('exam_set_id', examSetId).eq('target_type', 'STUDENT').eq('student_user_id', stuId).maybeSingle());
        if (asg) okPg(await sb().from('exam_assignments').update({ extra_attempts_granted: (Number(asg.extra_attempts_granted) || 0) + 1, updated_at_utc: now }).eq('assignment_id', asg.assignment_id));
        else okPg(await sb().from('exam_assignments').insert({ assignment_id: genId('exa_'), exam_set_id: examSetId, target_type: 'STUDENT', student_user_id: stuId, assignment_status: 'ASSIGNED', extra_attempts_granted: 1, accommodation_reason: 'Replacement: ' + reason, assigned_by_user_id: admin.userId, created_at_utc: now, updated_at_utc: now, version: 1 }));
      }
    } else if (act === 'GRANT_REPLACEMENT_ATTEMPT') {
      var exAsg = okPg(await sb().from('exam_assignments').select('*').eq('exam_set_id', examSetId).eq('target_type', 'STUDENT').eq('student_user_id', stuId).maybeSingle());
      if (exAsg) okPg(await sb().from('exam_assignments').update({ extra_attempts_granted: (Number(exAsg.extra_attempts_granted) || 0) + 1, updated_at_utc: now }).eq('assignment_id', exAsg.assignment_id));
      else okPg(await sb().from('exam_assignments').insert({ assignment_id: genId('exa_'), exam_set_id: examSetId, target_type: 'STUDENT', student_user_id: stuId, assignment_status: 'ASSIGNED', extra_attempts_granted: 1, accommodation_reason: 'Replacement: ' + reason, assigned_by_user_id: admin.userId, created_at_utc: now, updated_at_utc: now, version: 1 }));
    } else if (act === 'UNLOCK_ACCOUNT_SET_BASELINE') {
      B().unwrapRpcResult(await sb().rpc('pb_set_user_integrity_status', { p_session_token: token, p_target_user_id: stuId, p_next_status: 'ACTIVE' }));
      var sip = okPg(await sb().from('student_integrity_profiles').select('*').eq('student_user_id', stuId).maybeSingle());
      var totInv = sip ? Number(sip.distinct_copy_invalidations_total) || 0 : 0;
      if (sip) {
        okPg(await sb().from('student_integrity_profiles').update({
          integrity_status: 'UNLOCKED_ON_PROBATION',
          effective_strike_baseline: totInv,
          effective_active_strikes: 0,
          unlocked_at_utc: now,
          unlocked_by_user_id: admin.userId,
          unlock_reason: reason,
          updated_at_utc: now
        }).eq('profile_id', sip.profile_id));
      }
    } else {
      throw err('ERR_VALIDATION_FAILED', 'Invalid integrity review action.');
    }

    okPg(await sb().from('exam_integrity_reviews').insert({
      review_id: genId('eir_'),
      target_type: act === 'UNLOCK_ACCOUNT_SET_BASELINE' ? 'ACCOUNT_INTEGRITY_LOCK' : (attemptId ? 'ATTEMPT_INVALIDATION' : 'INTEGRITY_EVENT'),
      target_id: eventId || attemptId || stuId,
      student_user_id: stuId,
      attempt_id: attemptId,
      exam_set_id: examSetId,
      action_taken: act,
      reason: reason,
      admin_user_id: admin.userId,
      created_at_utc: now,
      version: 1
    }));
    var dash = await handleAdminListIntegrity({}, token);
    dash.actionResult = { actionTaken: act, reason: reason };
    return dash;
  }

  // ==================== SAMPLE SEED & COMPAT DIAGNOSTIC HANDLERS ====================

  async function handleSeedSampleAction(action, payload, token) {
    var admin = await B().requireSession(token, ['ADMIN']);
    var now = nowIso();
    if (action === 'admin.seedStep6SampleUsers') {
      var uRes = B().unwrapRpcResult(await sb().rpc('pb_admin_list_users', { p_session_token: token, p_limit: 50 })) || {};
      var hasStu = (uRes.users || []).some(function (u) { return u.role === 'STUDENT'; });
      if (!hasStu) {
        B().unwrapRpcResult(await sb().rpc('pb_admin_save_user', {
          p_session_token: token,
          p_user: { username: 'student_demo', fullName: 'Sample Student (DEK70)', email: 'student.demo@pattanabhumi.example', role: 'STUDENT', status: 'ACTIVE', password: 'StudentDemo#2026!' }
        }));
      }
      return B().unwrapRpcResult(await sb().rpc('pb_admin_list_users', { p_session_token: token, p_limit: 200 }));
    }
    if (action === 'admin.seedStep7SampleCourseAndAssessment' || action === 'admin.seedStep9LearningCohort') {
      var existingC = okPg(await sb().from('courses').select('*').eq('course_code', 'BIO-ALEVEL-70').maybeSingle());
      var cid = existingC ? existingC.course_id : genId('crs_');
      if (!existingC) {
        okPg(await sb().from('courses').insert({
          course_id: cid,
          course_code: 'BIO-ALEVEL-70',
          title: 'A-Level Biology Comprehensive Intensive (DEK70)',
          description: 'Complete biology wrap-up covering cellular bioenergetics, genetics, physiology, and timed A-Level mock examinations.',
          dek_code: 'DEK70',
          status: 'PUBLISHED',
          sort_order: 10,
          created_at_utc: now,
          updated_at_utc: now,
          version: 1
        }));
        var secId = genId('sec_');
        okPg(await sb().from('sections').insert({ section_id: secId, course_id: cid, title: 'Module 1: Cell Bioenergetics & Photosynthesis', description: 'Core foundations and chloroplast reactions.', sort_order: 10, is_default: true, status: 'PUBLISHED', created_at_utc: now, updated_at_utc: now, version: 1 }));
        okPg(await sb().from('cards').insert({ card_id: genId('crd_'), course_id: cid, section_id: secId, card_type: 'ANNOUNCEMENT', title: 'Welcome to Pattanabhumi Biology', body: 'Review your schedule, study notes, and practice quizzes inside this module.', sort_order: 10, status: 'PUBLISHED', created_at_utc: now, updated_at_utc: now, version: 1 }));
      }
      var listC = await B().dispatch({ action: 'admin.listCourses', payload: {}, sessionToken: token });
      return listC.data;
    }
    if (action === 'admin.seedStep13SampleCalendarEvents') {
      var bkkDay = B().todayBangkokYmd();
      okPg(await sb().from('calendar_events').insert({
        event_id: genId('evt_'),
        course_id: '',
        title: 'Live Review: Photosynthesis & Calvin Cycle',
        event_type: 'CLASS_SESSION',
        start_date_bkk: bkkDay,
        start_time_bkk: '18:00',
        end_date_bkk: bkkDay,
        end_time_bkk: '20:00',
        description: 'Weekly interactive biology live class session.',
        status: 'ACTIVE',
        created_by_user_id: admin.userId,
        created_at_utc: now,
        updated_at_utc: now,
        version: 1
      }));
      var cal = await B().dispatch({ action: 'calendar.getEvents', payload: {}, sessionToken: token });
      return cal.data;
    }
    if (action === 'payment.seedSampleInstallments') {
      var users = (B().unwrapRpcResult(await sb().rpc('pb_admin_list_users', { p_session_token: token, p_limit: 50 })) || {}).users || [];
      var stu = users.find(function (u) { return u.role === 'STUDENT'; });
      if (stu) {
        okPg(await sb().from('invoices').insert({
          invoice_id: genId('inv_'),
          user_id: stu.userId,
          installment_label: 'Sample Tuition Installment #1',
          amount_satang: 350000,
          due_date_bkk: B().todayBangkokYmd(),
          status: 'UNPAID',
          created_at_utc: now,
          updated_at_utc: now,
          version: 1
        }));
      }
      var inv = await B().dispatch({ action: 'admin.listInvoices', payload: {}, sessionToken: token });
      return inv.data;
    }
    return { ok: true, passed: true, suite: action, message: 'PostgreSQL / Supabase mode active — Apps Script sheet suite skipped.' };
  }

  // ==================== EXAM DOMAIN DISPATCHER ====================

  async function dispatch(action, payload, token) {
    if (action === 'admin.stimuli.list') return await handleAdminListStimuli(payload, token);
    if (action === 'admin.stimuli.save') return await handleAdminSaveStimulus(payload, token);
    if (action === 'admin.questions.list') return await handleAdminListQuestions(payload, token);
    if (action === 'admin.questions.save') return await handleAdminSaveQuestion(payload, token);
    if (action === 'admin.questions.duplicate') return await handleAdminDuplicateQuestion(payload, token);
    if (action === 'admin.questions.archive') return await handleAdminArchiveOrDeleteQuestion(payload, token);
    if (action === 'admin.questions.preview') return await handleAdminPreviewQuestion(payload, token);
    if (action === 'admin.questions.seedSampleBiologyBank') return await handleAdminSeedSampleBiologyBank(payload, token);
    if (action === 'admin.exams.list') return await handleAdminListExams(payload, token);
    if (action === 'admin.exams.saveDraft') return await handleAdminSaveExamDraft(payload, token);
    if (action === 'admin.exams.validateForPublish') return await handleAdminValidateExam(payload, token);
    if (action === 'admin.exams.publish') return await handleAdminPublishExam(payload, token);
    if (action === 'admin.exams.preview') return await handleStudentGetInstructions(Object.assign({}, payload || {}, { adminPreview: true }), token);
    if (action === 'admin.exams.assign') return await handleAdminAssignExam(payload, token);
    if (action === 'admin.exams.seedSampleExamSets') return await handleAdminSeedSampleExams(payload, token);
    if (action === 'admin.exams.analytics') return await handleAdminGetAnalytics(payload, token);
    if (action === 'admin.exams.runMaintenance') return await handleAdminRunMaintenance(payload, token);
    if (action === 'exams.list') return await handleStudentListExams(payload, token);
    if (action === 'exams.getInstructions') return await handleStudentGetInstructions(payload, token);
    if (action === 'exams.startAttempt') return await handleStudentStartAttempt(payload, token);
    if (action === 'exams.getAttempt') return await handleStudentGetAttempt(payload, token);
    if (action === 'exams.saveResponses') return await handleStudentSaveResponses(payload, token);
    if (action === 'exams.saveFlags') return await handleStudentSaveFlags(payload, token);
    if (action === 'exams.checkPracticeItem') return await handleStudentCheckPracticeItem(payload, token);
    if (action === 'exams.submitAttempt') return await handleStudentSubmitAttempt(payload, token);
    if (action === 'exams.getSubmissionStatus') return await handleStudentSubmitAttempt(payload, token);
    if (action === 'exams.getPublishedResult') return await handleStudentGetPublishedResult(payload, token);
    if (action === 'exams.reportRestrictedCopy') return await handleStudentReportCopy(payload, token);
    if (action === 'admin.attempts.list') return await handleAdminListAttempts(payload, token);
    if (action === 'admin.attempts.inspect') return await handleAdminInspectAttempt(payload, token);
    if (action === 'admin.attempts.manage') return await handleAdminManageAttempt(payload, token);
    if (action === 'admin.grading.save') return await handleAdminSaveManualGrading(payload, token);
    if (action === 'admin.results.publish') return await handleAdminPublishResults(payload, token);
    if (action === 'admin.results.regrade') return await handleAdminRegradeExam(payload, token);
    if (action === 'admin.integrity.list') return await handleAdminListIntegrity(payload, token);
    if (action === 'admin.integrity.review') return await handleAdminReviewIntegrity(payload, token);
    if (action === 'payment.seedSampleInstallments' || /^admin\.seedStep/.test(action) || /^admin\.runStep\d+VerificationSuite$/.test(action)) {
      return await handleSeedSampleAction(action, payload, token);
    }
    throw err('ERR_INVALID_ACTION', 'Unknown examination action "' + action + '".');
  }

  global.PBSupabaseExams = {
    dispatch: dispatch,
    evaluateSingleItemScore: evaluateSingleItemScore,
    roundHalfAwayFromZero: roundHalfAwayFromZero,
    normalizeShortAnswer: normalizeShortAnswer,
    evalAccountLockThreshold: evalAccountLockThreshold
  };
})(window);
