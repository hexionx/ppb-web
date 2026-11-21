/**
 * exam-pdf-export.js — Template-Based Exam PDF Export Engine (A-Level & POSN)
 *
 * Features:
 * - Private Thai web font loader via Supabase Storage (`private-fonts`) + FontFace API
 *   (Angsana New for A-Level, TH SarabunPSK for POSN) with graceful fallback stack.
 * - Authentic paginated A4 sheets for Template 1 (`alevel`) & Template 2 (`posn`),
 *   measuring real question heights so Slot 4 auto-calculates exact rendered page counts
 *   and per-section page ranges.
 * - Full pb-richtext-v1 renderer (bold, italic, underline, sub, sup, lists, data tables,
 *   Google Drive images, stimuli, and all 7 question types including Complex MCQ).
 * - Inline Code 39 vector barcode + scannable QR Code SVG generator.
 * - Per-exam Slot 1-5 persistence to Supabase `exam_sets.pdf_config` JSONB.
 * - Isolated `@media print` A4 output awaiting `document.fonts.ready` + all images.
 */
(function (global) {
  'use strict';

  var FONT_BUCKET = 'private-fonts';
  var ASSET_BUCKET = 'exam-pdf-assets';
  var DEFAULT_LOGO_PATH = 'assets/logo.webp';

  var PRIVATE_FONT_MANIFEST = {
    alevel: {
      family: 'Angsana New',
      fallbackStack: "'Angsana New', 'Cordia New', 'Sarabun', 'TH SarabunPSK', Tahoma, serif",
      files: [
        { path: 'AngsanaNew-Regular.woff2', weight: '400', style: 'normal' },
        { path: 'AngsanaNew-Bold.woff2', weight: '700', style: 'normal' },
        { path: 'AngsanaNew-Italic.woff2', weight: '400', style: 'italic' },
        { path: 'AngsanaNew-BoldItalic.woff2', weight: '700', style: 'italic' }
      ]
    },
    posn: {
      family: 'TH SarabunPSK',
      fallbackStack: "'TH SarabunPSK', 'Sarabun', 'Angsana New', Tahoma, sans-serif",
      files: [
        { path: 'THSarabunPSK-Regular.woff2', weight: '400', style: 'normal' },
        { path: 'THSarabunPSK-Bold.woff2', weight: '700', style: 'normal' },
        { path: 'THSarabunPSK-Italic.woff2', weight: '400', style: 'italic' },
        { path: 'THSarabunPSK-BoldItalic.woff2', weight: '700', style: 'italic' }
      ]
    }
  };

  var fontLoadCache = Object.create(null);
  var signedAssetCache = Object.create(null);
  var driveImageUrlCache = Object.create(null);

  var state = {
    exam: null,
    config: null,
    schoolMeta: {},
    zoom: 'fit',
    lastPageCount: 0,
    lastContentPageCount: 0,
    lastPagesHtml: [],
    previewTimer: null,
    isPrinting: false,
    modalBound: false,
    onConfigSaved: null
  };

  // ==================== UTILITIES ====================

  function getSb() {
    if (global.PBSupabaseBackend && typeof global.PBSupabaseBackend.getSupabase === 'function') {
      return global.PBSupabaseBackend.getSupabase();
    }
    return null;
  }

  function escHtml(val) {
    return String(val === undefined || val === null ? '' : val)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtNum(n) {
    var v = Number(n) || 0;
    return Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  }

  function computeExactTotalPointsBp(examDto) {
    var sections = Array.isArray(examDto && examDto.sections) ? examDto.sections : [];
    var sumBp = 0;
    var countedItems = 0;
    sections.forEach(function (sec) {
      var items = Array.isArray(sec && sec.items) ? sec.items : [];
      items.forEach(function (it) {
        if (!it) return;
        countedItems += 1;
        var bp = Number(it.pointsBp);
        if (isFinite(bp) && bp >= 0) sumBp += Math.round(bp);
      });
    });
    if (countedItems > 0 && sumBp > 0) return sumBp;
    var fallbackBp = Number(examDto && examDto.maxPointsBp);
    return isFinite(fallbackBp) && fallbackBp >= 0 ? Math.round(fallbackBp) : 0;
  }

  function formatExactBp(bp) {
    var intBp = Math.round(Number(bp) || 0);
    if (intBp % 100 === 0) return String(intBp / 100);
    return (intBp / 100).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  }

  function getThaiBuddhistDateDefaults() {
    var months = [
      'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
      'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'
    ];
    var shortMonths = [
      'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
      'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'
    ];
    var days = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
    var d = new Date(Date.now() + 7 * 3600 * 1000);
    var beYear = d.getUTCFullYear() + 543;
    var shortYear = String(beYear).slice(-2);
    var dayName = days[d.getUTCDay()];
    var mIdx = d.getUTCMonth();
    var monthName = months[mIdx];
    var monthAbbr = shortMonths[mIdx] || 'พ.ย.';
    return {
      beYear: String(beYear),
      shortYear: shortYear,
      fullDateTh: 'วัน' + dayName + 'ที่ ' + d.getUTCDate() + ' ' + monthName + ' พ.ศ. ' + beYear,
      shortMonthYearTh: monthAbbr + ' ' + shortYear
    };
  }

  function buildCleanPdfFilename(examDto, cfg) {
    var tplPrefix = cfg && cfg.template === 'posn' ? 'POSN' : 'A-Level';
    var codePart = String((cfg && cfg.subjectCode) || (examDto && examDto.examCode) || 'Exam').trim();
    var titlePart = String((examDto && examDto.title) || (cfg && cfg.subjectName) || 'Biology').trim();
    var raw = [tplPrefix, codePart, titlePart].filter(Boolean).join('_');
    var cleaned = raw
      .replace(/[\\/:*?"<>|\x00-\x1F]+/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 110);
    return cleaned || (tplPrefix + '_Exam');
  }

  function getDefaultAlevelCoverRules() {
    return [
      'ห้ามเปิดข้อสอบก่อนได้รับอนุญาตจากกรรมการคุมสอบ',
      'ให้เขียนชื่อ–สกุล เลขที่นั่งสอบ สถานที่สอบ และห้องสอบที่ปกข้อสอบ',
      'ใช้ดินสอดำ 2B ฝนวงกลมตัวเลือกในกระดาษคำตอบ ถ้าต้องการเปลี่ยนตัวเลือกใหม่ ต้องลบให้สะอาดจนหมดรอยดำ แล้วจึงฝนวงกลมตัวเลือกใหม่',
      'ห้ามใช้โทรศัพท์มือถือและอุปกรณ์อิเล็กทรอนิกส์ทุกชนิดระหว่างอยู่ในห้องสอบ',
      'ห้ามนำกระดาษคำตอบออกจากห้องสอบ',
      'ห้ามผู้เข้าสอบออกจากห้องสอบก่อนหมดเวลาสอบ หรือก่อนได้รับอนุญาตจากกรรมการคุมสอบ'
    ].join('\n');
  }

  function getDefaultAlevelInstructions() {
    return [
      'เขียนชื่อ – นามสกุล เลขที่นั่งสอบ สถานที่สอบและห้องสอบด้วยปากกา บนหน้าปกแบบทดสอบ',
      'ตรวจสอบ ชื่อ – นามสกุล เลขที่นั่งสอบ รหัสวิชาสอบ เลขประจำตัวประชาชน 13 หลัก บนกระดาษคำตอบว่าตรงกับตัวผู้เข้าสอบหรือไม่ กรณีที่ไม่ตรง ให้แจ้งผู้คุมสอบเพื่อขอแก้ไขบนกระดาษคำตอบ และใบลงนามเข้าสอบ',
      'ตรวจสอบ รหัสวิชาสอบ และเลขที่นั่งสอบบนกระดาษคำตอบว่าถูกต้องหรือไม่ กรณีที่ไม่ถูกต้อง ให้แจ้งผู้คุมสอบเพื่อขอกระดาษคำตอบสำรอง แล้วกรอกข้อมูลด้วยปากกา และระบายด้วยดินสอดำเบอร์ 2B ให้ตรงกับตัวเลขที่เขียน',
      'ใช้ดินสอดำเบอร์ 2B ระบายวงกลมตัวเลือกในกระดาษคำตอบให้เต็มวง (ห้ามระบายนอกวง) ถ้าต้องการเปลี่ยนตัวเลือกใหม่ ต้องลบให้สะอาดจนหมดรอยดำแล้วจึงระบายวงกลมตัวเลือกใหม่',
      'อ่านคำแนะนำวิธีการตอบแบบทดสอบให้เข้าใจ แล้วตอบแบบทดสอบด้วยตนเองโดยไม่เอื้อให้ผู้อื่นคัดลอกคำตอบได้',
      'สามารถใช้พื้นที่ว่างในแบบทดสอบเป็นกระดาษทดได้',
      'ห้าม ฉีก / ตัด / พับ แบบทดสอบในขณะอยู่ในห้องสอบ โดยเด็ดขาด',
      'รูปประกอบในข้อสอบ อาจไม่เป็นไปตามสัดส่วนจริง',
      'ไม่อนุญาตให้ผู้เข้าสอบออกจากห้องสอบ ก่อนหมดเวลาสอบ',
      'ผู้เข้าสอบต้องส่งกระดาษคำตอบให้กับผู้คุมสอบก่อนออกจากห้องสอบ และกระดาษคำตอบจะไม่ถูกตรวจ หากถูกนำออกจากห้องสอบโดยผู้ที่มิใช่ผู้คุมสอบ ทุกกรณี',
      'ไม่อนุญาตให้ผู้คุมสอบเปิดอ่านแบบทดสอบ หรือเก็บแบบทดสอบที่ถูกทิ้งไว้ไปเป็นของตนเองโดยเด็ดขาด'
    ].join('\n');
  }

  function getDefaultPosnRules() {
    return [
      'ใช้ปากกาเขียนชื่อ นามสกุล เลขประจำตัวสอบ สถานที่สอบ และใช้ดินสอ 2B ขึ้นไป ระบายลงในวงกลมให้ตรงกับเลขประจำตัวสอบ และรหัสชุดวิชาที่กรอกในกระดาษคำตอบ',
      'ข้อสอบส่วนที่เป็นแบบปรนัยชนิดเลือกตอบ 4 ตัวเลือก กรณีที่ตัวเลือกในข้อสอบกระดาษคำตอบไม่ตรงกันให้ถือตามข้อกำหนดข้างล่างนี้\n  ข้อ ก. = a = A = i = 1\n  ข้อ ข. = b = B = ii = 2\n  ข้อ ค. = c = C = iii = 3\n  ข้อ ง. = d = D = iv = 4',
      'วิธีตอบ ทำการระบายคำตอบข้อที่ถูกต้องที่สุด ลงในกระดาษคำตอบด้วยดินสอ 2B ขึ้นไป ให้นักเรียนพิจารณาเลือกคำตอบที่ถูกต้องที่สุดเพียงคำตอบเดียว ถ้าข้อใดตอบมากกว่า 1 ตัวเลือก ข้อนั้นถือเป็นโมฆะ',
      'ห้ามนำข้อสอบและกระดาษคำตอบออกจากห้องสอบ',
      'ห้ามเผยแพร่ก่อนได้รับอนุญาตจากผู้จัดทำข้อสอบ',
      'ห้ามใช้เครื่องคำนวณ',
      'ห้ามนักเรียนออกจากห้องสอบก่อนหมดเวลาสอบ หรือก่อนได้รับอนุญาตจากกรรมการคุมสอบ'
    ].join('\n');
  }

  function buildDefaultConfig(examDto, schoolMeta) {
    var ex = examDto || {};
    var sm = schoolMeta || {};
    var dt = getThaiBuddhistDateDefaults();
    var titleLower = String(ex.title || '').toLowerCase();
    var isPosnHint = /สอวน|posn|ค่าย\s*1|olympiad/i.test(String(ex.title || '') + ' ' + String(ex.examCode || ''));
    var schoolName = sm.schoolName || 'Pattanabhumi Biology';
    var saved = ex.pdfConfig && typeof ex.pdfConfig === 'object' ? ex.pdfConfig : {};
    var baseUrl = '';
    try {
      baseUrl = global.location ? (global.location.origin + global.location.pathname) : 'https://hexionx.github.io/ppb-web/';
    } catch (_e) {
      baseUrl = 'https://hexionx.github.io/ppb-web/';
    }
    var defaultAuthor = 'พี่ภูมิ ภูวเดช เขื่อนแก้ว';
    var durationMin = Number(ex.durationMinutes) > 0 ? Number(ex.durationMinutes) : 90;

    var defaults = {
      template: isPosnHint ? 'posn' : 'alevel',
      // Slot 1: Brand / Logo / Watermark
      logoUrl: DEFAULT_LOGO_PATH,
      bannerOrgName: schoolName,
      bannerMainTitle: isPosnHint ? 'ข้อสอบวิชาชีววิทยา' : 'Pre-Admission Biology',
      bannerBadgeTop: 'TCAS',
      bannerBadgeNum: dt.shortYear,
      bannerRoundText: 'A-Level  |  รอบสอบ ' + dt.shortMonthYearTh,
      posnEmblemShape: 'auto',
      watermarkEnabled: true,
      watermarkUrl: '',
      watermarkText: schoolName,
      watermarkOpacity: 10,
      // Slot 2: Subject & Code
      subjectName: 'ชีววิทยา',
      subjectCode: isPosnHint ? (ex.examCode || '0000005') : '66',
      examDateText: dt.fullDateTh,
      examTimeText: durationMin === 90 ? 'เวลา 08.30 – 10.00 น.' : ('เวลาสอบ ' + durationMin + ' นาที'),
      choiceStyle: 'AUTO',
      includeQuestionZero: !isPosnHint,
      // Slot 3: Author / Program Subtitle
      authorText: defaultAuthor,
      posnObjectiveBox: 'แบบทดสอบจำลองเตรียมความพร้อมค่าย 1 (Pre-POSN) ปีการศึกษา ' + dt.beYear,
      // Slot 4: Structure & Rules
      setNumber: '1',
      durationMinutesOverride: '',
      alevelCoverRules: getDefaultAlevelCoverRules(),
      alevelInstructions: getDefaultAlevelInstructions(),
      posnRules: getDefaultPosnRules(),
      copyrightNotice: 'ข้อสอบชุดนี้ ผู้เข้าสอบสามารถนำกลับบ้านไปทบทวนได้ หลังหมดเวลาสอบ\nห้ามทำสำเนา, ถ่ายเอกสาร, ถ่ายภาพ เพื่อแจกจ่ายหรือจำหน่าย',
      // Slot 5: A-Level Footer Bar
      barcodeValue: String(ex.examCode || '66').replace(/[^A-Z0-9\-]/gi, '').slice(0, 14) || '66',
      releaseScheduleText: 'ตรวจสอบคะแนนและเฉลยละเอียด\nได้ที่ระบบ Pattanabhumi Biology Portal\nหรือสแกน QR Code ด้านข้าง',
      qrUrl: baseUrl,
      socialHandle: baseUrl,
      socialCaption: 'สอบถาม / อัปเดตข้อมูลได้ที่',
      // Extras
      includeAnswerKey: false,
      fontSizePt: 16
    };

    var merged = Object.assign({}, defaults, saved);
    if (merged.template !== 'alevel' && merged.template !== 'posn') {
      merged.template = defaults.template;
    }
    // Normalize any legacy malformed "พฤศ." month abbreviation saved in old pdf_config
    if (merged.bannerRoundText && merged.bannerRoundText.indexOf('พฤศ.') !== -1) {
      merged.bannerRoundText = merged.bannerRoundText.replace(/พฤศ\./g, 'พ.ย.');
    }
    var op = Number(merged.watermarkOpacity);
    merged.watermarkOpacity = isFinite(op) ? Math.max(4, Math.min(25, Math.round(op))) : 10;
    return merged;
  }

  // ==================== PRIVATE FONT LOADER (SUPABASE STORAGE) ====================

  async function loadPrivateFonts(templateKey) {
    var key = templateKey === 'posn' ? 'posn' : 'alevel';
    var spec = PRIVATE_FONT_MANIFEST[key];
    if (!spec) return { loadedCount: 0, totalCount: 0, family: 'Sarabun', usedFallback: true, errors: [] };
    if (fontLoadCache[key] && fontLoadCache[key].done) {
      return fontLoadCache[key];
    }

    var result = {
      key: key,
      family: spec.family,
      fallbackStack: spec.fallbackStack,
      loadedCount: 0,
      totalCount: spec.files.length,
      usedFallback: true,
      errors: [],
      done: false
    };

    var sb = getSb();
    if (!sb || !sb.storage || typeof FontFace !== 'function') {
      result.errors.push('Supabase Storage client or FontFace API unavailable.');
      result.done = true;
      fontLoadCache[key] = result;
      return result;
    }

    var tasks = spec.files.map(async function (f) {
      try {
        var signed = await sb.storage.from(FONT_BUCKET).createSignedUrl(f.path, 3600);
        if (signed.error || !signed.data || !signed.data.signedUrl) {
          result.errors.push(f.path + ': ' + ((signed.error && signed.error.message) || 'not found'));
          return false;
        }
        var face = new FontFace(spec.family, 'url("' + signed.data.signedUrl + '") format("woff2")', {
          weight: f.weight,
          style: f.style,
          display: 'swap'
        });
        var loadedFace = await face.load();
        document.fonts.add(loadedFace);
        result.loadedCount += 1;
        return true;
      } catch (e) {
        result.errors.push(f.path + ': ' + ((e && e.message) || 'failed to load'));
        return false;
      }
    });

    await Promise.all(tasks);
    try {
      if (document.fonts && document.fonts.ready) {
        await document.fonts.ready;
      }
    } catch (_eReady) {}

    result.usedFallback = result.loadedCount === 0;
    result.done = true;
    fontLoadCache[key] = result;
    return result;
  }

  // ==================== ASSET & IMAGE URL RESOLUTION ====================

  async function resolveAssetUrl(rawUrl) {
    var s = String(rawUrl || '').trim();
    if (!s) return '';
    if (s.indexOf('storage://') === 0) {
      if (signedAssetCache[s] && signedAssetCache[s].expiresAt > Date.now()) {
        return signedAssetCache[s].url;
      }
      var rest = s.slice('storage://'.length);
      var slash = rest.indexOf('/');
      if (slash <= 0) return '';
      var bucket = rest.slice(0, slash);
      var objPath = rest.slice(slash + 1);
      var sb = getSb();
      if (!sb || !sb.storage) return '';
      try {
        var res = await sb.storage.from(bucket).createSignedUrl(objPath, 3600);
        if (res && res.data && res.data.signedUrl) {
          signedAssetCache[s] = { url: res.data.signedUrl, expiresAt: Date.now() + 3000 * 1000 };
          return res.data.signedUrl;
        }
      } catch (_e) {}
      return '';
    }
    if (/^fil_[a-z0-9_-]{4,64}$/i.test(s)) {
      return await resolvePortalFileIdToUrl(s);
    }
    return s;
  }

  async function resolvePortalFileIdToUrl(fileId) {
    var fid = String(fileId || '').trim();
    if (!fid) return '';
    if (driveImageUrlCache[fid]) return driveImageUrlCache[fid];
    try {
      if (global.PBObjectUrlManager && typeof global.PBObjectUrlManager.fetchAndCreateObjectUrl === 'function') {
        var courseId = state.exam && state.exam.courseId ? state.exam.courseId : '';
        var entry = await global.PBObjectUrlManager.fetchAndCreateObjectUrl(fid, courseId);
        if (entry && entry.objectUrl) {
          driveImageUrlCache[fid] = entry.objectUrl;
          return entry.objectUrl;
        }
      }
    } catch (_eObj) {}
    try {
      var sb = getSb();
      if (sb) {
        var fRes = await sb.from('files').select('drive_file_id,web_view_link').eq('file_id', fid).maybeSingle();
        if (fRes && fRes.data && fRes.data.drive_file_id && global.PB_DRIVE) {
          var url = global.PB_DRIVE.getGoogleDriveImageUrl(fRes.data.drive_file_id, 1400);
          driveImageUrlCache[fid] = url;
          return url;
        }
      }
    } catch (_eDb) {}
    return '';
  }

  async function preloadAllExamImageUrls(examDto, cfg) {
    var fileIds = new Set();
    function collectFromRichDoc(doc) {
      if (!doc || !Array.isArray(doc.blocks)) return;
      doc.blocks.forEach(function (b) {
        if (b && b.type === 'image_attachment' && b.fileId) fileIds.add(b.fileId);
      });
    }
    var sections = Array.isArray(examDto && examDto.sections) ? examDto.sections : [];
    sections.forEach(function (sec) {
      collectFromRichDoc(sec && sec.instructionsRichText);
      var items = Array.isArray(sec && sec.items) ? sec.items : [];
      items.forEach(function (it) {
        var qp = it && it.questionPreview;
        if (!qp) return;
        collectFromRichDoc(qp.stemRichText);
        if (qp.imageFileId) fileIds.add(qp.imageFileId);
        if (Array.isArray(qp.imageFileIds)) {
          qp.imageFileIds.forEach(function (id) { if (id) fileIds.add(id); });
        }
        if (qp.stimulus) {
          collectFromRichDoc(qp.stimulus.contentRichText);
          if (qp.stimulus.imageFileId) fileIds.add(qp.stimulus.imageFileId);
        }
        if (Array.isArray(qp.options)) {
          qp.options.forEach(function (opt) {
            collectFromRichDoc(opt && opt.contentRichText);
            if (opt && opt.imageFileId) fileIds.add(opt.imageFileId);
          });
        }
      });
    });

    var urlMap = {};
    var promises = Array.from(fileIds).map(async function (fid) {
      urlMap[fid] = await resolvePortalFileIdToUrl(fid);
    });
    var logoPromise = resolveAssetUrl(cfg.logoUrl || DEFAULT_LOGO_PATH);
    var wmPromise = resolveAssetUrl(cfg.watermarkUrl || cfg.logoUrl || DEFAULT_LOGO_PATH);
    await Promise.all(promises);
    return {
      fileUrlMap: urlMap,
      logoSrc: await logoPromise,
      watermarkSrc: await wmPromise
    };
  }

  async function uploadAssetToSupabase(fileObj, kind) {
    var sb = getSb();
    if (!sb || !sb.storage) throw new Error('Supabase Storage client is not initialized.');
    var extMatch = String(fileObj.name || '').match(/\.([a-z0-9]{2,5})$/i);
    var ext = extMatch ? extMatch[1].toLowerCase() : 'png';
    if (!/^(png|jpe?g|webp|svg)$/.test(ext)) ext = 'png';
    var examId = (state.exam && state.exam.examSetId) ? state.exam.examSetId.replace(/[^a-zA-Z0-9_-]/g, '') : 'shared';
    var path = 'exams/' + examId + '/' + kind + '_' + Date.now() + '.' + ext;
    var up = await sb.storage.from(ASSET_BUCKET).upload(path, fileObj, {
      cacheControl: '3600',
      upsert: true,
      contentType: fileObj.type || ('image/' + (ext === 'jpg' ? 'jpeg' : ext))
    });
    if (up.error) throw new Error(up.error.message || 'Upload failed.');
    return 'storage://' + ASSET_BUCKET + '/' + path;
  }

  // ==================== VECTOR BARCODE (CODE 39) & QR CODE SVG ====================

  var CODE39_MAP = {
    '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn',
    '4': 'nnnwwnnnw', '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw',
    '8': 'wnnwnnwnn', '9': 'nnwwnnwnn', 'A': 'wnnnnwnnw', 'B': 'nnwnnwnnw',
    'C': 'wnwnnwnnn', 'D': 'nnnnwwnnw', 'E': 'wnnnwwnnn', 'F': 'nnwnwwnnn',
    'G': 'nnnnnwwnw', 'H': 'wnnnnwwnn', 'I': 'nnwnnwwnn', 'J': 'nnnnwwwnn',
    'K': 'wnnnnnnww', 'L': 'nnwnnnnww', 'M': 'wnwnnnnwn', 'N': 'nnnnwnnww',
    'O': 'wnnnwnnwn', 'P': 'nnwnwnnwn', 'Q': 'nnnnnnwww', 'R': 'wnnnnnwwn',
    'S': 'nnwnnnwwn', 'T': 'nnnnwnwwn', 'U': 'wwnnnnnnw', 'V': 'nwwnnnnnw',
    'W': 'wwwnnnnnn', 'X': 'nwnnwnnnw', 'Y': 'wwnnwnnnn', 'Z': 'nwwnwnnnn',
    '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn', '*': 'nwnnwnwnn'
  };

  function buildCode39Svg(rawText) {
    var clean = String(rawText || '66').toUpperCase().replace(/[^0-9A-Z\-\. ]/g, '').slice(0, 14) || '66';
    var encoded = '*' + clean + '*';
    var x = 2;
    var narrow = 1.5;
    var wide = 3.6;
    var h = 34;
    var rects = [];
    for (var i = 0; i < encoded.length; i++) {
      var pat = CODE39_MAP[encoded.charAt(i)] || CODE39_MAP['0'];
      for (var j = 0; j < pat.length; j++) {
        var w = pat.charAt(j) === 'w' ? wide : narrow;
        if (j % 2 === 0) {
          rects.push('<rect x="' + x.toFixed(1) + '" y="0" width="' + w.toFixed(1) + '" height="' + h + '" fill="#111111"/>');
        }
        x += w;
      }
      x += narrow;
    }
    var totalW = Math.ceil(x + 2);
    return (
      '<svg class="pb-pdf-barcode-svg" viewBox="0 0 ' + totalW + ' ' + h + '" width="110" height="32" role="img" aria-label="Barcode ' + escHtml(clean) + '">' +
      rects.join('') +
      '</svg>'
    );
  }

  function buildQrCodeSvg(urlText) {
    var val = String(urlText || '').trim();
    if (!val) return '';
    try {
      if (typeof global.qrcode === 'function') {
        var qr = global.qrcode(0, 'M');
        qr.addData(val, 'Byte');
        qr.make();
        var count = qr.getModuleCount();
        var quietModules = 4; // ISO/IEC 18004 standard 4-module pure white quiet zone

        // Prefer high-DPI crisp PNG via Canvas (>400 DPI at 22mm print size, zero SVG seam artifacts in Chrome PDF)
        if (typeof document !== 'undefined') {
          try {
            var pxCell = 10;
            var pxQuiet = pxCell * quietModules;
            var pxSize = count * pxCell + pxQuiet * 2;
            var canvas = document.createElement('canvas');
            canvas.width = pxSize;
            canvas.height = pxSize;
            var ctx = canvas.getContext && canvas.getContext('2d');
            if (ctx) {
              ctx.fillStyle = '#FFFFFF';
              ctx.fillRect(0, 0, pxSize, pxSize);
              ctx.fillStyle = '#000000';
              for (var r = 0; r < count; r++) {
                for (var c = 0; c < count; c++) {
                  if (qr.isDark(r, c)) {
                    ctx.fillRect(pxQuiet + c * pxCell, pxQuiet + r * pxCell, pxCell, pxCell);
                  }
                }
              }
              var pngUrl = canvas.toDataURL('image/png');
              if (pngUrl && pngUrl.indexOf('data:image/png') === 0) {
                return (
                  '<img class="pb-pdf-qr-svg" src="' + pngUrl + '" width="84" height="84" alt="QR Code for ' + escHtml(val) + '" />'
                );
              }
            }
          } catch (_eCanvas) {}
        }

        // Vector SVG fallback with 4-module white quiet zone
        var cell = 4;
        var quiet = cell * quietModules;
        var size = count * cell + quiet * 2;
        var rects = [];
        for (var sr = 0; sr < count; sr++) {
          for (var sc = 0; sc < count; sc++) {
            if (qr.isDark(sr, sc)) {
              rects.push(
                '<rect x="' + (quiet + sc * cell) + '" y="' + (quiet + sr * cell) + '" width="' + cell + '" height="' + cell + '" fill="#000000"/>'
              );
            }
          }
        }
        return (
          '<svg class="pb-pdf-qr-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" width="84" height="84" shape-rendering="crispEdges" role="img" aria-label="QR Code for ' + escHtml(val) + '">' +
          '<rect x="0" y="0" width="' + size + '" height="' + size + '" fill="#FFFFFF"/>' +
          rects.join('') +
          '</svg>'
        );
      }
    } catch (_eQr) {}
    return '<div class="pb-pdf-qr-fallback">QR</div>';
  }

  function buildHexMarkerSvg() {
    return '<svg class="pb-pdf-hex-marker" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><polygon points="12,2 21,7 21,17 12,22 3,17 3,7" fill="#111111"/></svg>';
  }

  // ==================== RICH TEXT & QUESTION RENDERING ====================

  function renderSpansToHtml(spans) {
    if (!Array.isArray(spans) || spans.length === 0) return '';
    return spans.map(function (s) {
      if (!s || s.text === undefined || s.text === null) return '';
      var txt = escHtml(String(s.text));
      if (!txt) return '';
      var out = txt;
      if (s.bold) out = '<strong>' + out + '</strong>';
      if (s.italic) out = '<em>' + out + '</em>';
      if (s.underline) out = '<u>' + out + '</u>';
      if (s.sup) out = '<sup class="pb-pdf-sup">' + out + '</sup>';
      else if (s.sub) out = '<sub class="pb-pdf-sub">' + out + '</sub>';
      return out;
    }).join('');
  }

  function renderRichDocToHtml(doc, fileUrlMap, inlineSinglePara) {
    if (!doc || !Array.isArray(doc.blocks) || doc.blocks.length === 0) return '';
    var blocks = doc.blocks;
    if (inlineSinglePara && blocks.length === 1 && blocks[0] && blocks[0].type === 'paragraph') {
      return renderSpansToHtml(blocks[0].spans);
    }
    var out = [];
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'paragraph') {
        var html = renderSpansToHtml(b.spans);
        if (html.trim()) {
          out.push('<p class="pb-pdf-p">' + html + '</p>');
        }
      } else if (b.type === 'bullet_list' || b.type === 'ordered_list') {
        var tag = b.type === 'ordered_list' ? 'ol' : 'ul';
        var items = Array.isArray(b.items) ? b.items : [];
        var lis = items.map(function (item) {
          var spans = Array.isArray(item) ? item : (item && Array.isArray(item.spans) ? item.spans : []);
          return '<li>' + renderSpansToHtml(spans) + '</li>';
        }).join('');
        if (lis) out.push('<' + tag + ' class="pb-pdf-list">' + lis + '</' + tag + '>');
      } else if (b.type === 'table' && Array.isArray(b.rows)) {
        var capHtml = b.caption ? '<caption class="pb-pdf-tbl-cap">' + escHtml(b.caption) + '</caption>' : '';
        var headHtml = '';
        if (Array.isArray(b.headers) && b.headers.length > 0) {
          headHtml = '<thead><tr>' + b.headers.map(function (h) { return '<th>' + escHtml(h) + '</th>'; }).join('') + '</tr></thead>';
        }
        var bodyHtml = '<tbody>' + b.rows.map(function (row) {
          var cells = Array.isArray(row) ? row : [];
          return '<tr>' + cells.map(function (c) { return '<td>' + escHtml(c) + '</td>'; }).join('') + '</tr>';
        }).join('') + '</tbody>';
        out.push('<table class="pb-pdf-data-table">' + capHtml + headHtml + bodyHtml + '</table>');
      } else if (b.type === 'image_attachment' && b.fileId) {
        var src = (fileUrlMap && fileUrlMap[b.fileId]) || '';
        if (src) {
          var wStyle = (b.widthPct && Number(b.widthPct) > 0)
            ? ' style="width:' + Math.min(100, Math.max(20, Math.round(Number(b.widthPct)))) + '%;"'
            : '';
          var cap = b.caption && !/\.(png|jpe?g|webp|gif|svg|bmp)$/i.test(String(b.caption).trim())
            ? '<figcaption class="pb-pdf-fig-cap">' + escHtml(b.caption) + '</figcaption>'
            : '';
          out.push(
            '<figure class="pb-pdf-figure"' + wStyle + '>' +
            '<img class="pb-pdf-q-img" src="' + escHtml(src) + '" alt="' + escHtml(b.altText || b.caption || 'Diagram') + '" referrerpolicy="no-referrer" />' +
            cap +
            '</figure>'
          );
        }
      }
    }
    return out.join('');
  }

  function getChoiceLabel(idx, cfg, optKey) {
    var mode = cfg.choiceStyle || 'AUTO';
    if (mode === 'AUTO') {
      mode = cfg.template === 'posn' ? 'THAI' : 'NUMBER';
    }
    if (mode === 'THAI') {
      var thai = ['ก.', 'ข.', 'ค.', 'ง.', 'จ.', 'ฉ.', 'ช.', 'ซ.'];
      return thai[idx] || (String(idx + 1) + '.');
    }
    if (mode === 'ALPHA') {
      var alpha = ['A.', 'B.', 'C.', 'D.', 'E.', 'F.', 'G.', 'H.'];
      return alpha[idx] || (String(idx + 1) + '.');
    }
    if (mode === 'KEY' && optKey) {
      return String(optKey).replace(/\.$/, '') + '.';
    }
    return String(idx + 1) + '.';
  }

  function buildQuestionBlockHtml(item, qNumber, cfg, fileUrlMap, seenStimulusIds) {
    var qp = item && item.questionPreview ? item.questionPreview : null;
    if (!qp) return '';
    var parts = [];

    // Shared stimulus (only once before first question using it)
    if (qp.stimulus && qp.stimulus.stimulusId && !seenStimulusIds[qp.stimulus.stimulusId]) {
      seenStimulusIds[qp.stimulus.stimulusId] = true;
      var stimHtml = renderRichDocToHtml(qp.stimulus.contentRichText, fileUrlMap, false);
      var stimImg = qp.stimulus.imageFileId && fileUrlMap[qp.stimulus.imageFileId]
        ? '<figure class="pb-pdf-figure"><img class="pb-pdf-q-img" src="' + escHtml(fileUrlMap[qp.stimulus.imageFileId]) + '" alt="Stimulus" referrerpolicy="no-referrer"/></figure>'
        : '';
      if (stimHtml || stimImg) {
        parts.push(
          '<div class="pb-pdf-stimulus-box">' +
          (qp.stimulus.title ? '<div class="pb-pdf-stimulus-title">' + escHtml(qp.stimulus.title) + '</div>' : '') +
          stimHtml + stimImg +
          '</div>'
        );
      }
    }

    var stemHtml = renderRichDocToHtml(qp.stemRichText, fileUrlMap, false);
    if (!stemHtml) {
      stemHtml = '<p class="pb-pdf-p">' + escHtml(qp.title || item.title || '') + '</p>';
    }

    // Attach standalone question image(s) if not already embedded via image_attachment
    var extraImgIds = [];
    if (qp.imageFileId) extraImgIds.push(qp.imageFileId);
    if (Array.isArray(qp.imageFileIds)) {
      qp.imageFileIds.forEach(function (id) {
        if (id && extraImgIds.indexOf(id) === -1) extraImgIds.push(id);
      });
    }
    var stemImgHtml = extraImgIds.map(function (fid) {
      var src = fileUrlMap[fid];
      if (!src) return '';
      var cap = qp.imageCaption ? '<figcaption class="pb-pdf-fig-cap">' + escHtml(qp.imageCaption) + '</figcaption>' : '';
      return '<figure class="pb-pdf-figure"><img class="pb-pdf-q-img" src="' + escHtml(src) + '" alt="' + escHtml(qp.imageAltText || 'Question diagram') + '" referrerpolicy="no-referrer"/>' + cap + '</figure>';
    }).join('');

    var qType = String(qp.questionType || item.questionType || 'SINGLE_CHOICE').toUpperCase();
    var options = Array.isArray(qp.options) ? qp.options : [];
    var bodyHtml = '';

    if (qType === 'COMPLEX_MULTIPLE_CHOICE') {
      // Official A-Level Complex MCQ statement table (ข้อความ | ใช่ | ไม่ใช่)
      var rowsHtml = options.map(function (opt, idx) {
        var cHtml = renderRichDocToHtml(opt.contentRichText, fileUrlMap, true) || escHtml(opt.plainText || '');
        var oImg = opt.imageFileId && fileUrlMap[opt.imageFileId]
          ? '<div><img class="pb-pdf-opt-img" src="' + escHtml(fileUrlMap[opt.imageFileId]) + '" alt="" referrerpolicy="no-referrer"/></div>'
          : '';
        return (
          '<tr>' +
          '<td class="pb-pdf-cmc-num">' + qNumber + '.' + (idx + 1) + '</td>' +
          '<td class="pb-pdf-cmc-stmt">' + cHtml + oImg + '</td>' +
          '<td class="pb-pdf-cmc-box">☐</td>' +
          '<td class="pb-pdf-cmc-box">☐</td>' +
          '</tr>'
        );
      }).join('');
      bodyHtml =
        '<table class="pb-pdf-cmc-table">' +
        '<thead><tr><th style="width:42px;">ข้อ</th><th>ข้อความ</th><th style="width:48px;">ใช่</th><th style="width:52px;">ไม่ใช่</th></tr></thead>' +
        '<tbody>' + rowsHtml + '</tbody>' +
        '</table>';
    } else if (qType === 'SINGLE_CHOICE' || qType === 'MULTIPLE_SELECT' || qType === 'TRUE_FALSE') {
      var isMulti = qType === 'MULTIPLE_SELECT';
      var optItems = options.map(function (opt, idx) {
        var lbl = getChoiceLabel(idx, cfg, opt.optionKey);
        var cHtml = renderRichDocToHtml(opt.contentRichText, fileUrlMap, true) || escHtml(opt.plainText || '');
        var oImg = opt.imageFileId && fileUrlMap[opt.imageFileId]
          ? '<div class="pb-pdf-opt-img-wrap"><img class="pb-pdf-opt-img" src="' + escHtml(fileUrlMap[opt.imageFileId]) + '" alt="' + escHtml(opt.imageAltText || '') + '" referrerpolicy="no-referrer"/></div>'
          : '';
        return (
          '<li class="pb-pdf-option-item">' +
          '<span class="pb-pdf-option-key">' + (isMulti ? '☐ ' : '') + escHtml(lbl) + '</span>' +
          '<div class="pb-pdf-option-content">' + cHtml + oImg + '</div>' +
          '</li>'
        );
      }).join('');
      bodyHtml =
        (isMulti && qp.selectionInstruction ? '<div class="pb-pdf-q-hint">' + escHtml(qp.selectionInstruction) + '</div>' : '') +
        '<ol class="pb-pdf-options-list">' + optItems + '</ol>';
    } else if (qType === 'NUMERIC_RESPONSE' || qType === 'SHORT_ANSWER') {
      var unit = qp.unitLabel ? ' <span class="pb-pdf-unit-label">' + escHtml(qp.unitLabel) + '</span>' : '';
      bodyHtml =
        '<div class="pb-pdf-short-answer-line">' +
        '<span>คำตอบ : </span><span class="pb-pdf-dotted-fill"></span>' + unit +
        '</div>';
    } else if (qType === 'WRITTEN_RESPONSE') {
      bodyHtml =
        '<div class="pb-pdf-written-lines">' +
        '<div class="pb-pdf-ruled-line"></div>' +
        '<div class="pb-pdf-ruled-line"></div>' +
        '<div class="pb-pdf-ruled-line"></div>' +
        '<div class="pb-pdf-ruled-line"></div>' +
        '</div>';
    }

    parts.push(
      '<div class="pb-pdf-question-item">' +
      '<div class="pb-pdf-question-row">' +
      '<span class="pb-pdf-q-num">' + qNumber + '.</span>' +
      '<div class="pb-pdf-q-body">' + stemHtml + stemImgHtml + bodyHtml + '</div>' +
      '</div>' +
      '</div>'
    );
    return parts.join('');
  }

  function buildQuestionTypeSummaryTh(examDto) {
    var bd = (examDto && examDto.questionTypeBreakdown) || {};
    var segments = [];
    var sc = Number(bd.SINGLE_CHOICE || 0);
    var cmc = Number(bd.COMPLEX_MULTIPLE_CHOICE || 0);
    var ms = Number(bd.MULTIPLE_SELECT || 0);
    var tf = Number(bd.TRUE_FALSE || 0);
    var num = Number(bd.NUMERIC_RESPONSE || 0);
    var sa = Number(bd.SHORT_ANSWER || 0);
    var wr = Number(bd.WRITTEN_RESPONSE || 0);
    if (sc > 0) segments.push('แบบปรนัยเลือกตอบ ' + sc + ' ข้อ');
    if (cmc > 0) segments.push('เลือกตอบเชิงซ้อน ' + cmc + ' ข้อ');
    if (ms > 0) segments.push('เลือกตอบหลายคำตอบ ' + ms + ' ข้อ');
    if (tf > 0) segments.push('ถูก/ผิด ' + tf + ' ข้อ');
    if (num > 0) segments.push('เติมคำตอบตัวเลข ' + num + ' ข้อ');
    if (sa > 0) segments.push('ตอบสั้น ' + sa + ' ข้อ');
    if (wr > 0) segments.push('อัตนัย ' + wr + ' ข้อ');
    return segments.join(' และ');
  }

  // ==================== PAGINATION & TEMPLATE RENDERERS ====================

  function createMeasurementHost(cfg) {
    var existing = document.getElementById('pb-pdf-measure-host');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    var host = document.createElement('div');
    host.id = 'pb-pdf-measure-host';
    host.className = 'pb-pdf-doc pb-pdf-tpl-' + cfg.template;
    host.style.cssText = [
      'position:fixed',
      'left:-99999px',
      'top:0',
      'width:180mm',
      'visibility:hidden',
      'pointer-events:none',
      'z-index:-1',
      'font-size:' + (Number(cfg.fontSizePt) || 16) + 'pt'
    ].join(';');
    document.body.appendChild(host);
    return host;
  }

  function mmToPx(mm) {
    var probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:-9999px;top:0;height:' + mm + 'mm;width:1px;visibility:hidden;';
    document.body.appendChild(probe);
    var h = probe.getBoundingClientRect().height || (mm * 3.7795275591);
    document.body.removeChild(probe);
    return h;
  }

  function paginateQuestionBlocks(examDto, cfg, fileUrlMap) {
    var sections = Array.isArray(examDto && examDto.sections) ? examDto.sections : [];
    var blocks = [];
    var qCounter = 0;
    var seenStim = {};

    if (cfg.template === 'alevel' && cfg.includeQuestionZero) {
      blocks.push({
        kind: 'q0',
        sectionIdx: 0,
        html:
          '<div class="pb-pdf-question-item pb-pdf-q0">' +
          '<div class="pb-pdf-question-row">' +
          '<span class="pb-pdf-q-num"><strong>0.</strong></span>' +
          '<div class="pb-pdf-q-body">' +
          '<p class="pb-pdf-p"><strong>แบบทดสอบที่ท่านกำลังทำอยู่นี้ เป็นแบบทดสอบชุดที่เท่าไร</strong> (ฝนในกระดาษคำตอบ ข้อที่ 0)</p>' +
          '<ol class="pb-pdf-options-list pb-pdf-q0-opts">' +
          '<li class="pb-pdf-option-item"><span class="pb-pdf-option-key">1.</span><div class="pb-pdf-option-content">ชุดที่ 1</div></li>' +
          '<li class="pb-pdf-option-item"><span class="pb-pdf-option-key">2.</span><div class="pb-pdf-option-content">ชุดที่ 2</div></li>' +
          '</ol>' +
          '</div></div></div>'
      });
    }

    sections.forEach(function (sec, sIdx) {
      var items = Array.isArray(sec.items) ? sec.items : [];
      var secInstHtml = renderRichDocToHtml(sec.instructionsRichText, fileUrlMap, false);
      var secTitle = sec.title || ('ตอนที่ ' + (sIdx + 1));
      var secSummary = 'จำนวนรวม ' + items.length + ' ข้อ' +
        (Number(sec.sectionMaxPointsBp) > 0 ? ' (คะแนนเต็ม ' + fmtNum(Number(sec.sectionMaxPointsBp) / 100) + ' คะแนน)' : '');
      blocks.push({
        kind: 'section_header',
        sectionIdx: sIdx,
        html:
          '<div class="pb-pdf-section-banner">' +
          '<div class="pb-pdf-section-banner-title">' + escHtml(secTitle) + ' — ' + escHtml(secSummary) + '</div>' +
          (secInstHtml ? '<div class="pb-pdf-section-banner-inst">' + secInstHtml + '</div>' : '') +
          '</div>'
      });
      items.forEach(function (it) {
        qCounter += 1;
        var qHtml = buildQuestionBlockHtml(it, qCounter, cfg, fileUrlMap, seenStim);
        if (qHtml) {
          blocks.push({
            kind: 'question',
            sectionIdx: sIdx,
            qNum: qCounter,
            html: qHtml
          });
        }
      });
    });

    if (blocks.length === 0) {
      blocks.push({
        kind: 'empty',
        sectionIdx: 0,
        html: '<div class="pb-pdf-empty-note">ยังไม่มีข้อสอบในชุดแบบทดสอบนี้ (เพิ่มข้อสอบใน Exam Builder ก่อนส่งออก PDF)</div>'
      });
    }

    // Measure exact rendered heights in active template typography
    var host = createMeasurementHost(cfg);
    var usableHeightMm = cfg.template === 'alevel' ? 238 : 248;
    var maxPagePx = mmToPx(usableHeightMm);

    var measured = blocks.map(function (blk) {
      var wrap = document.createElement('div');
      wrap.innerHTML = blk.html;
      host.appendChild(wrap);
      var h = wrap.getBoundingClientRect().height;
      host.removeChild(wrap);
      return Object.assign({}, blk, { heightPx: Math.max(18, h + 4) });
    });
    if (host.parentNode) host.parentNode.removeChild(host);

    var pages = [];
    var current = [];
    var curH = 0;

    for (var i = 0; i < measured.length; i++) {
      var item = measured[i];
      var nextItem = measured[i + 1];
      // Prevent orphaned section header at bottom of page
      var neededH = item.kind === 'section_header' && nextItem
        ? item.heightPx + Math.min(nextItem.heightPx, maxPagePx * 0.5)
        : item.heightPx;

      if (current.length > 0 && curH + neededH > maxPagePx) {
        pages.push(current);
        current = [];
        curH = 0;
      }
      current.push(item);
      curH += item.heightPx;
    }
    if (current.length > 0) {
      pages.push(current);
    }

    // Track per-section page ranges
    var startOffset = cfg.template === 'alevel' ? 3 : 2;
    var sectionPageRanges = {};
    pages.forEach(function (pgItems, pIdx) {
      var pgNo = startOffset + pIdx;
      pgItems.forEach(function (b) {
        if (b.sectionIdx === undefined) return;
        if (!sectionPageRanges[b.sectionIdx]) {
          sectionPageRanges[b.sectionIdx] = { start: pgNo, end: pgNo };
        } else {
          sectionPageRanges[b.sectionIdx].end = pgNo;
        }
      });
    });

    return {
      questionPages: pages,
      totalQuestions: qCounter,
      sectionPageRanges: sectionPageRanges
    };
  }

  function resolveCorrectAnswerDisplay(item, cfg) {
    var qp = item && item.questionPreview ? item.questionPreview : null;
    if (!qp) return '-';
    var gSpec = (qp.privateGradingData && qp.privateGradingData.gradingSpec) || qp.gradingSpecPrivate || {};
    var isFree = Boolean(item.isFreeQuestion || qp.isFreeQuestion || gSpec.isFreeQuestion);
    if (isFree) return 'ฟรี (ทุกข้อถูก)';

    var qType = String(qp.questionType || item.questionType || 'SINGLE_CHOICE').toUpperCase();
    var opts = Array.isArray(qp.options) ? qp.options : [];

    if (qType === 'COMPLEX_MULTIPLE_CHOICE') {
      var map = gSpec.statementTruthMap || {};
      if (opts.length === 0) return '-';
      return opts.map(function (o, idx) {
        var isTrue = map[o.optionId] !== undefined ? Boolean(map[o.optionId]) : Boolean(o.isCorrect || o.isCorrectPrivate);
        return (idx + 1) + ':' + (isTrue ? 'ใช่' : 'ไม่ใช่');
      }).join(', ');
    }

    if (opts.length > 0 && (qType === 'SINGLE_CHOICE' || qType === 'MULTIPLE_SELECT' || qType === 'TRUE_FALSE')) {
      var correctIds = Array.isArray(gSpec.correctOptionIds) ? gSpec.correctOptionIds : [];
      var correctKeys = Array.isArray(gSpec.correctOptionKeys) ? gSpec.correctOptionKeys : [];
      var hits = [];
      opts.forEach(function (o, idx) {
        var matched =
          Boolean(o.isCorrect) ||
          Boolean(o.isCorrectPrivate) ||
          Boolean(o.is_correct_private) ||
          (o.optionId && correctIds.indexOf(o.optionId) !== -1) ||
          (o.optionKey && correctKeys.indexOf(o.optionKey) !== -1);
        if (matched) {
          hits.push(getChoiceLabel(idx, cfg, o.optionKey).replace(/\.$/, ''));
        }
      });
      if (hits.length > 0) return hits.join(', ');
    }

    if (qType === 'NUMERIC_RESPONSE') {
      var numVal = gSpec.expectedNumericValue !== undefined ? gSpec.expectedNumericValue
        : (gSpec.numericValue !== undefined ? gSpec.numericValue : gSpec.correctNumber);
      if (numVal !== undefined && numVal !== null && numVal !== '') {
        var tol = Number(gSpec.toleranceAbs || gSpec.tolerance || 0);
        var uLbl = qp.unitLabel ? (' ' + qp.unitLabel) : '';
        return String(numVal) + (tol > 0 ? (' ± ' + tol) : '') + uLbl;
      }
    }

    if (qType === 'SHORT_ANSWER') {
      var acc = Array.isArray(gSpec.acceptedAnswers) ? gSpec.acceptedAnswers
        : (Array.isArray(gSpec.acceptedTexts) ? gSpec.acceptedTexts : []);
      var texts = acc.map(function (a) {
        return typeof a === 'string' ? a.trim() : (a && a.text ? String(a.text).trim() : '');
      }).filter(Boolean);
      if (texts.length > 0) return texts.join(' / ');
    }

    if (qType === 'WRITTEN_RESPONSE') {
      return 'อัตนัย (ตรวจโดยผู้สอน)';
    }

    return '-';
  }

  function buildAnswerKeyPagesHtml(examDto, cfg, startPageNum) {
    var sections = Array.isArray(examDto && examDto.sections) ? examDto.sections : [];
    var entries = [];
    var qNo = 0;
    sections.forEach(function (sec) {
      (sec.items || []).forEach(function (it) {
        qNo += 1;
        var ptsStr = it.isFreeQuestion ? 'ฟรี' : formatExactBp(it.pointsBp !== undefined ? it.pointsBp : 100);
        entries.push({
          num: qNo,
          ans: resolveCorrectAnswerDisplay(it, cfg),
          pts: ptsStr
        });
      });
    });

    if (entries.length === 0) return [];

    // Compact 2-column side-by-side grid: up to 50 questions (25 per column) cleanly per A4 page
    var PER_PAGE = 50;
    var pageChunks = [];
    for (var i = 0; i < entries.length; i += PER_PAGE) {
      pageChunks.push(entries.slice(i, i + PER_PAGE));
    }

    function renderSubTable(subEntries) {
      if (!subEntries || subEntries.length === 0) return '';
      var rowsHtml = subEntries.map(function (e) {
        return (
          '<tr>' +
          '<td class="pb-pdf-ak-col-num">' + e.num + '</td>' +
          '<td class="pb-pdf-ak-col-ans">' + escHtml(e.ans) + '</td>' +
          '<td class="pb-pdf-ak-col-pts">' + escHtml(e.pts) + '</td>' +
          '</tr>'
        );
      }).join('');
      return (
        '<table class="pb-pdf-ak-table">' +
        '<thead><tr><th class="pb-pdf-ak-col-num">ข้อที่</th><th class="pb-pdf-ak-col-ans">คำตอบที่ถูกต้อง</th><th class="pb-pdf-ak-col-pts">คะแนน</th></tr></thead>' +
        '<tbody>' + rowsHtml + '</tbody>' +
        '</table>'
      );
    }

    var totalAkPages = pageChunks.length;
    var totalScoreStr = formatExactBp(computeExactTotalPointsBp(examDto));

    return pageChunks.map(function (chunk, cIdx) {
      var splitAt = Math.ceil(chunk.length / 2);
      var leftEntries = chunk.slice(0, splitAt);
      var rightEntries = chunk.slice(splitAt);
      var pgLabel = totalAkPages > 1
        ? ('หน้าเฉลย ' + (cIdx + 1) + ' / ' + totalAkPages + ' (หน้า ' + (startPageNum + cIdx) + ')')
        : ('หน้า ' + (startPageNum + cIdx));
      return (
        '<section class="pb-pdf-page pb-pdf-tpl-' + cfg.template + ' pb-pdf-answer-key-page">' +
        '<div class="pb-pdf-ak-header">' +
        '<div><strong>เฉลยคำตอบ (สำหรับผู้สอน)</strong> — ' + escHtml(examDto.title || cfg.subjectName) + '</div>' +
        '<div>' + escHtml(pgLabel) + '</div>' +
        '</div>' +
        '<div class="pb-pdf-ak-submeta">จำนวนทั้งหมด ' + entries.length + ' ข้อ &nbsp;|&nbsp; คะแนนเต็ม ' + escHtml(totalScoreStr) + ' คะแนน</div>' +
        '<div class="pb-pdf-ak-grid' + (rightEntries.length === 0 ? ' is-single' : '') + '">' +
        '<div class="pb-pdf-ak-col">' + renderSubTable(leftEntries) + '</div>' +
        (rightEntries.length > 0 ? '<div class="pb-pdf-ak-col">' + renderSubTable(rightEntries) + '</div>' : '') +
        '</div>' +
        '</section>'
      );
    });
  }

  function buildWatermarkHtml(cfg, watermarkSrc) {
    if (!cfg.watermarkEnabled) return '';
    var opacity = (Math.max(4, Math.min(25, Number(cfg.watermarkOpacity) || 10)) / 100).toFixed(2);
    // When a watermark logo image is present, show ONLY the faint translucent logo (no duplicate text underneath)
    if (watermarkSrc) {
      return (
        '<div class="pb-pdf-watermark" style="opacity:' + opacity + ';" aria-hidden="true">' +
        '<img class="pb-pdf-wm-img" src="' + escHtml(watermarkSrc) + '" alt="" referrerpolicy="no-referrer"/>' +
        '</div>'
      );
    }
    var txt = cfg.watermarkText
      ? '<div class="pb-pdf-wm-text">' + escHtml(cfg.watermarkText) + '</div>'
      : '';
    return txt ? '<div class="pb-pdf-watermark" style="opacity:' + opacity + ';" aria-hidden="true">' + txt + '</div>' : '';
  }

  // ---- TEMPLATE 1: A-LEVEL (TCAS / ทปอ.) ----

  function buildAlevelDocumentHtml(examDto, cfg, assets, paged) {
    var sections = Array.isArray(examDto && examDto.sections) ? examDto.sections : [];
    var baseContentPages = paged.questionPages.length;
    var totalExamPages = 2 + baseContentPages; // Page 1 Cover + Page 2 Instructions + Page 3+ Questions
    var totalQuestions = paged.totalQuestions || Number(examDto.totalQuestionsCount) || 0;
    var exactTotalBp = computeExactTotalPointsBp(examDto);
    var fullScoreStr = formatExactBp(exactTotalBp);
    var durationMin = Number(cfg.durationMinutesOverride) > 0
      ? Number(cfg.durationMinutesOverride)
      : (Number(examDto.durationMinutes) || 90);
    var typeSummaryTh = buildQuestionTypeSummaryTh(examDto) || ('แบบปรนัย ' + totalQuestions + ' ข้อ');

    var sectionLinesHtml = sections.map(function (sec, idx) {
      var rng = paged.sectionPageRanges[idx];
      var pgRangeTxt = rng ? (' (หน้า ' + rng.start + (rng.end > rng.start ? '–' + rng.end : '') + ')') : '';
      var items = Array.isArray(sec.items) ? sec.items : [];
      var qCnt = items.length > 0 ? items.length : (Number(sec.sectionQuestionsCount) || 0);
      var secBp = 0;
      items.forEach(function (it) {
        var b = Number(it && it.pointsBp);
        if (isFinite(b) && b >= 0) secBp += Math.round(b);
      });
      if (secBp === 0 && Number(sec.sectionMaxPointsBp) > 0) secBp = Math.round(Number(sec.sectionMaxPointsBp));
      var ptsStr = formatExactBp(secBp);
      return (
        '<div class="pb-al-struct-line">' +
        '<strong>' + escHtml(sec.title || ('ตอนที่ ' + (idx + 1))) + '</strong>' +
        escHtml(pgRangeTxt) + ' &nbsp; จำนวน ' + qCnt + ' ข้อ &nbsp; คะแนนเต็ม ' + ptsStr + ' คะแนน' +
        '</div>'
      );
    }).join('');

    var coverRules = String(cfg.alevelCoverRules || '').split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    var coverRulesHtml = coverRules.map(function (r, idx) {
      return '<li><span class="pb-al-rule-num">' + (idx + 1) + '.</span><span>' + escHtml(r) + '</span></li>';
    }).join('');

    var copyrightHtml = String(cfg.copyrightNotice || '').split(/\r?\n/).map(function (l) {
      return '<div>' + escHtml(l.trim()) + '</div>';
    }).join('');

    var releaseHtml = String(cfg.releaseScheduleText || '').split(/\r?\n/).map(function (l) {
      return '<div>' + escHtml(l.trim()) + '</div>';
    }).join('');

    var logoImgTag = assets.logoSrc
      ? '<img class="pb-al-slot1-logo" src="' + escHtml(assets.logoSrc) + '" alt="Logo" referrerpolicy="no-referrer"/>'
      : '';
    var smallLogoTag = assets.logoSrc
      ? '<img class="pb-al-header-logo" src="' + escHtml(assets.logoSrc) + '" alt="Logo" referrerpolicy="no-referrer"/>'
      : '';

    // PAGE 1: COVER PAGE
    var page1 =
      '<section class="pb-pdf-page pb-pdf-tpl-alevel pb-al-cover-page">' +
      // Slot 1: Top Banner
      '<div class="pb-al-slot1-banner">' +
      '<div class="pb-al-slot1-left">' +
      (logoImgTag ? '<div class="pb-al-slot1-logo-wrap">' + logoImgTag + '</div>' : '') +
      '<div class="pb-al-slot1-titles">' +
      '<div class="pb-al-slot1-org">' + escHtml(cfg.bannerOrgName) + '</div>' +
      '<div class="pb-al-slot1-main">' + escHtml(cfg.bannerMainTitle) + '</div>' +
      '<div class="pb-al-slot1-round-pill">' + escHtml(cfg.bannerRoundText) + '</div>' +
      '</div>' +
      '</div>' +
      '<div class="pb-al-slot1-badge">' +
      '<div class="pb-al-slot1-badge-top">' + escHtml(cfg.bannerBadgeTop || 'TCAS') + '</div>' +
      '<div class="pb-al-slot1-badge-num">' + escHtml(cfg.bannerBadgeNum || '69') + '</div>' +
      '</div>' +
      '</div>' +

      // Student Information Fill Lines
      '<div class="pb-al-student-fields">' +
      '<div class="pb-al-field-row">' +
      '<span class="pb-al-field-lbl">ชื่อ–นามสกุล</span><span class="pb-al-dotline is-wide"></span>' +
      '<span class="pb-al-field-lbl">เลขที่นั่งสอบ</span><span class="pb-al-dotline"></span>' +
      '</div>' +
      '<div class="pb-al-field-row">' +
      '<span class="pb-al-field-lbl">สถานที่สอบ</span><span class="pb-al-dotline is-wide"></span>' +
      '<span class="pb-al-field-lbl">ห้องสอบ</span><span class="pb-al-dotline"></span>' +
      '</div>' +
      '</div>' +

      // Slot 2: Subject & Code Box
      '<div class="pb-al-slot2-row">' +
      '<span class="pb-al-badge-dark">A-Level</span>' +
      '<span class="pb-al-subject-prefix">วิชา</span>' +
      '<div class="pb-al-slot2-subject-box">' +
      '<span class="pb-al-subject-name">' + escHtml(cfg.subjectName) + '</span>' +
      '<span class="pb-al-subject-code">รหัสวิชา ' + escHtml(cfg.subjectCode) + '</span>' +
      '</div>' +
      '</div>' +

      // Slot 3: Author Box
      '<div class="pb-al-slot3-row">' +
      '<span class="pb-al-author-lbl">ข้อสอบโดย :</span>' +
      '<span class="pb-al-author-name">' + escHtml(cfg.authorText) + '</span>' +
      '</div>' +

      // Slot 4: Exam Structure Box
      '<div class="pb-al-slot4-box">' +
      '<div class="pb-al-set-pill">ชุดแบบทดสอบที่ ' + escHtml(cfg.setNumber || '1') + '</div>' +
      '<div class="pb-al-struct-headline">ข้อสอบมี ' + totalExamPages + ' หน้า &nbsp; จำนวน ' + totalQuestions + ' ข้อ &nbsp; คะแนนเต็ม ' + fullScoreStr + ' คะแนน &nbsp; เวลาสอบ ' + durationMin + ' นาที</div>' +
      (sectionLinesHtml || '') +
      '</div>' +

      // Exam Date & Time
      '<div class="pb-al-datetime-block">' +
      '<div>' + escHtml(cfg.examDateText) + '</div>' +
      '<div>' + escHtml(cfg.examTimeText) + '</div>' +
      '</div>' +

      // Rules Box + Side Tear Label
      '<div class="pb-al-rules-stage">' +
      '<div class="pb-al-rules-box">' +
      '<ol class="pb-al-rules-list">' + coverRulesHtml + '</ol>' +
      '</div>' +
      '<div class="pb-al-tear-note" aria-hidden="true">อย่าใช้มือแกะ • แกะปรุ เปิดกระดาษตามรอยปรุ</div>' +
      '</div>' +

      // Copyright Notice
      '<div class="pb-al-copyright">' + copyrightHtml + '</div>' +

      // Slot 5: Footer Bar (Balanced Barcode | Schedule + QR | Divider | Social)
      '<div class="pb-al-slot5-footer">' +
      '<div class="pb-al-f-barcode">' +
      buildCode39Svg(cfg.barcodeValue || cfg.subjectCode) +
      '<div class="pb-al-f-barcode-lbl">' + escHtml(cfg.barcodeValue || cfg.subjectCode) + '</div>' +
      '</div>' +
      '<div class="pb-al-f-center-group">' +
      '<div class="pb-al-f-schedule">' + releaseHtml + '</div>' +
      (cfg.qrUrl ? '<div class="pb-al-f-qr">' + buildQrCodeSvg(cfg.qrUrl) + '</div>' : '') +
      '</div>' +
      '<div class="pb-al-f-social">' +
      '<div class="pb-al-f-social-cap">' + escHtml(cfg.socialCaption || 'สอบถาม / อัปเดตข้อมูลได้ที่') + '</div>' +
      '<div class="pb-al-f-social-handle">' + buildFooterWebsiteLinkHtml(cfg.socialHandle) + '</div>' +
      '</div>' +
      '</div>' +
      '</section>';

    // PAGE 2: INSTRUCTIONS PAGE (คำอธิบายวิธีทำแบบทดสอบ)
    var instItems = String(cfg.alevelInstructions || '').split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    var instItem1 =
      'แบบทดสอบ รหัสวิชา ' + escHtml(cfg.subjectCode) + ' A-Level ' + escHtml(cfg.subjectName) +
      ' มี <strong>' + totalExamPages + ' หน้า</strong> มีทั้งหมด ' + Math.max(1, sections.length) + ' ตอน จำนวน <strong>' + totalQuestions + ' ข้อ</strong> ' +
      '(' + escHtml(typeSummaryTh) + ')' +
      '<br/>(คะแนนรวม <strong>' + fullScoreStr + ' คะแนน</strong> ให้<u>ทำข้อสอบทุกข้อ</u> ภายในเวลา <strong><u>' + durationMin + ' นาที</u></strong>)';

    var instListHtml =
      '<li><span class="pb-al-inst-num">1.</span><div>' + instItem1 + '</div></li>' +
      instItems.map(function (line, idx) {
        return '<li><span class="pb-al-inst-num">' + (idx + 2) + '.</span><div>' + escHtml(line) + '</div></li>';
      }).join('');

    var page2 =
      '<section class="pb-pdf-page pb-pdf-tpl-alevel pb-al-inst-page">' +
      '<div class="pb-al-inst-topbar">' +
      '<div class="pb-al-inst-logo">' + smallLogoTag + '</div>' +
      '<div class="pb-al-page-num">หน้าที่ &nbsp; 2</div>' +
      '</div>' +
      '<div class="pb-al-inst-frame">' +
      '<h2 class="pb-al-inst-title">คำอธิบายวิธีทำแบบทดสอบ</h2>' +
      '<ol class="pb-al-inst-list">' + instListHtml + '</ol>' +
      '</div>' +
      '<div class="pb-pdf-page-footer-marker">' + buildHexMarkerSvg() + '</div>' +
      '</section>';

    // PAGE 3+: QUESTION PAGES
    var wmHtml = buildWatermarkHtml(cfg, assets.watermarkSrc);
    var qPagesHtml = paged.questionPages.map(function (pgBlocks, pIdx) {
      var pgNum = 3 + pIdx;
      var innerHtml = pgBlocks.map(function (b) { return b.html; }).join('');
      return (
        '<section class="pb-pdf-page pb-pdf-tpl-alevel pb-al-q-page">' +
        wmHtml +
        '<header class="pb-al-running-header">' +
        '<div class="pb-al-rh-left">' +
        '<div class="pb-al-rh-subj">รหัสวิชา ' + escHtml(cfg.subjectCode) + ' ' + escHtml(cfg.subjectName) + '</div>' +
        '<div class="pb-al-rh-meta">' + escHtml(cfg.examDateText) + '</div>' +
        '</div>' +
        '<div class="pb-al-rh-center">' + smallLogoTag + '</div>' +
        '<div class="pb-al-rh-right">' +
        '<div class="pb-al-rh-pg">หน้าที่ ' + pgNum + '</div>' +
        '<div class="pb-al-rh-meta">' + escHtml(cfg.examTimeText) + '</div>' +
        '</div>' +
        '</header>' +
        '<div class="pb-pdf-q-flow">' + innerHtml + '</div>' +
        '<div class="pb-pdf-page-footer-marker">' + buildHexMarkerSvg() + '</div>' +
        '</section>'
      );
    });

    var allPages = [page1, page2].concat(qPagesHtml);
    if (cfg.includeAnswerKey) {
      allPages = allPages.concat(buildAnswerKeyPagesHtml(examDto, cfg, totalExamPages + 1));
    }
    return {
      pagesHtml: allPages,
      totalPages: totalExamPages,
      contentPages: baseContentPages
    };
  }

  function buildFooterWebsiteLinkHtml(rawContact) {
    var txt = String(rawContact || '').trim();
    if (!txt) return '';
    var href = '';
    if (/^https?:\/\//i.test(txt)) {
      href = txt;
    } else if (/^[a-z0-9.-]+\.[a-z]{2,}(\/[^\s]*)?$/i.test(txt)) {
      href = 'https://' + txt;
    }
    if (href) {
      var display = txt.replace(/^https?:\/\//i, '').replace(/\/$/, '');
      return '<a class="pb-al-f-social-link" href="' + escHtml(href) + '" target="_blank" rel="noopener noreferrer">' + escHtml(display) + '</a>';
    }
    return escHtml(txt);
  }

  // ---- TEMPLATE 2: POSN (สอวน.) ----

  function buildPosnDocumentHtml(examDto, cfg, assets, paged) {
    var contentPages = paged.questionPages.length; // Excluding cover page!
    var totalQuestions = paged.totalQuestions || Number(examDto.totalQuestionsCount) || 0;
    var shapeClass = cfg.posnEmblemShape === 'circle'
      ? ' is-circle'
      : cfg.posnEmblemShape === 'square'
      ? ' is-square'
      : '';
    var logoImgTag = assets.logoSrc
      ? '<img class="pb-posn-emblem' + shapeClass + '" src="' + escHtml(assets.logoSrc) + '" alt="Emblem" referrerpolicy="no-referrer"/>'
      : '';

    var rawRuleBlocks = String(cfg.posnRules || '').split(/\n(?=\S)/).map(function (b) { return b.trim(); }).filter(Boolean);
    var rulesListHtml =
      '<li><span class="pb-posn-rnum">1.</span><div>ข้อสอบมี ' + contentPages + ' หน้า (ไม่รวมปก) จำนวน ' + totalQuestions + ' ข้อ</div></li>' +
      rawRuleBlocks.map(function (trimmed, idx) {
        var itemNum = idx + 2;
        var lines = trimmed.split(/\r?\n/);
        var first = escHtml(lines[0]).replace(/^วิธีตอบ(\s*)/, '<strong>วิธีตอบ</strong>$1');
        var isLastExitRule = (itemNum === rawRuleBlocks.length + 1) && /ห้ามนักเรียนออกจากห้องสอบ/.test(lines[0]);
        if (isLastExitRule || itemNum === 8) {
          first = '<span class="pb-posn-rule-underline">' + first + '</span>';
        }
        var subLines = lines.slice(1).map(function (sl) {
          return '<div class="pb-posn-rule-indent">' + escHtml(sl.trim()) + '</div>';
        }).join('');
        return '<li><span class="pb-posn-rnum">' + itemNum + '.</span><div>' + first + subLines + '</div></li>';
      }).join('');

    // PAGE 1: POSN COVER PAGE
    var page1 =
      '<section class="pb-pdf-page pb-pdf-tpl-posn pb-posn-cover-page">' +
      // Slot 1: Centered Emblem
      '<div class="pb-posn-slot1-emblem">' + logoImgTag + '</div>' +
      // Exam Title + Slot 3 Objective Box
      '<div class="pb-posn-main-title">' + escHtml(cfg.bannerMainTitle || ('ข้อสอบวิชา' + cfg.subjectName)) + '</div>' +
      '<div class="pb-posn-slot3-box">' + escHtml(cfg.posnObjectiveBox) + '</div>' +

      // Two-Column Metadata Block (Left: Student Info, Right: Slot 2 Subject/Code + Date/Time)
      '<div class="pb-posn-meta-grid">' +
      '<div class="pb-posn-meta-left">' +
      '<div class="pb-posn-m-row"><span class="pb-posn-m-lbl">ชื่อ–สกุล</span><span class="pb-posn-dotline"></span></div>' +
      '<div class="pb-posn-m-row"><span class="pb-posn-m-lbl">เลขประจำตัวสอบ</span><span class="pb-posn-dotline"></span></div>' +
      '<div class="pb-posn-m-row"><span class="pb-posn-m-lbl">สถานที่สอบ</span><span class="pb-posn-dotline"></span></div>' +
      '<div class="pb-posn-m-row"><span class="pb-posn-m-lbl">ห้องสอบ</span><span class="pb-posn-dotline"></span></div>' +
      '</div>' +
      '<div class="pb-posn-meta-right">' +
      '<div class="pb-posn-slot2-subject">ข้อสอบวิชา' + escHtml(cfg.subjectName) + '</div>' +
      '<div class="pb-posn-slot2-code">รหัสชุดวิชา ' + escHtml(cfg.subjectCode) + '</div>' +
      '<div class="pb-posn-slot2-date">สอบ' + escHtml(cfg.examDateText) + '</div>' +
      '<div class="pb-posn-slot2-time">' + escHtml(cfg.examTimeText) + '</div>' +
      '</div>' +
      '</div>' +

      // Slot 4: Instructions (คำชี้แจง)
      '<div class="pb-posn-slot4-instructions">' +
      '<div class="pb-posn-inst-heading">คำชี้แจง</div>' +
      '<ol class="pb-posn-rules-list">' + rulesListHtml + '</ol>' +
      '</div>' +
      '</section>';

    // PAGE 2+: QUESTION PAGES
    var wmHtml = buildWatermarkHtml(cfg, assets.watermarkSrc);
    var qPagesHtml = paged.questionPages.map(function (pgBlocks, pIdx) {
      var contentPgNo = pIdx + 1;
      var innerHtml = pgBlocks.map(function (b) { return b.html; }).join('');
      return (
        '<section class="pb-pdf-page pb-pdf-tpl-posn pb-posn-q-page">' +
        wmHtml +
        '<header class="pb-posn-running-header">' +
        '<div class="pb-posn-rh-left">ข้อสอบวิชา' + escHtml(cfg.subjectName) + ' &nbsp;|&nbsp; รหัสชุดวิชา ' + escHtml(cfg.subjectCode) + '</div>' +
        '<div class="pb-posn-rh-right">หน้า ' + contentPgNo + ' / ' + contentPages + '</div>' +
        '</header>' +
        '<div class="pb-pdf-q-flow">' + innerHtml + '</div>' +
        '</section>'
      );
    });

    var allPages = [page1].concat(qPagesHtml);
    if (cfg.includeAnswerKey) {
      allPages = allPages.concat(buildAnswerKeyPagesHtml(examDto, cfg, contentPages + 1));
    }
    return {
      pagesHtml: allPages,
      totalPages: 1 + contentPages,
      contentPages: contentPages
    };
  }

  // ==================== MODAL UI, LIVE PREVIEW & PRINT ====================

  function setFontStatusPill(fontRes) {
    var pill = document.getElementById('pdf-export-font-status');
    if (!pill) return;
    if (!fontRes) {
      pill.className = 'badge';
      pill.textContent = 'Checking private fonts...';
      return;
    }
    if (!fontRes.usedFallback) {
      pill.className = 'badge badge-ok';
      pill.textContent = fontRes.family + ' loaded (' + fontRes.loadedCount + '/' + fontRes.totalCount + ' weights from private-fonts)';
      pill.title = 'Custom .woff2 web fonts loaded via Supabase signed URLs.';
    } else {
      pill.className = 'badge badge-incomplete';
      pill.textContent = 'Fallback font active — upload ' + fontRes.family + ' .woff2 to private-fonts';
      pill.title = (fontRes.errors || []).join('\n');
    }
  }

  function syncTemplateFieldVisibility(tpl) {
    var isAlevel = tpl === 'alevel';
    var alOnly = document.querySelectorAll('[data-pdf-tpl-only="alevel"]');
    var posnOnly = document.querySelectorAll('[data-pdf-tpl-only="posn"]');
    for (var i = 0; i < alOnly.length; i++) alOnly[i].classList.toggle('hidden', !isAlevel);
    for (var j = 0; j < posnOnly.length; j++) posnOnly[j].classList.toggle('hidden', isAlevel);

    var btnAl = document.getElementById('btn-pdf-tpl-alevel');
    var btnPosn = document.getElementById('btn-pdf-tpl-posn');
    if (btnAl) {
      btnAl.classList.toggle('is-active', isAlevel);
      btnAl.setAttribute('aria-pressed', isAlevel ? 'true' : 'false');
    }
    if (btnPosn) {
      btnPosn.classList.toggle('is-active', !isAlevel);
      btnPosn.setAttribute('aria-pressed', !isAlevel ? 'true' : 'false');
    }
  }

  function populateFormFromConfig(cfg) {
    function setVal(id, v) {
      var el = document.getElementById(id);
      if (el) el.value = v === undefined || v === null ? '' : String(v);
    }
    function setChk(id, b) {
      var el = document.getElementById(id);
      if (el) el.checked = Boolean(b);
    }
    syncTemplateFieldVisibility(cfg.template);
    setVal('input-pdf-logo-url', cfg.logoUrl);
    setVal('input-pdf-banner-org', cfg.bannerOrgName);
    setVal('input-pdf-banner-title', cfg.bannerMainTitle);
    setVal('input-pdf-banner-round', cfg.bannerRoundText);
    setVal('input-pdf-badge-top', cfg.bannerBadgeTop);
    setVal('input-pdf-badge-num', cfg.bannerBadgeNum);
    setVal('select-pdf-posn-emblem-shape', cfg.posnEmblemShape || 'auto');
    setChk('chk-pdf-watermark-enabled', cfg.watermarkEnabled);
    setVal('input-pdf-watermark-url', cfg.watermarkUrl);
    setVal('input-pdf-watermark-text', cfg.watermarkText);
    setVal('input-pdf-watermark-opacity', cfg.watermarkOpacity);
    var opLbl = document.getElementById('label-pdf-watermark-opacity');
    if (opLbl) opLbl.textContent = String(cfg.watermarkOpacity) + '%';

    setVal('input-pdf-subject-name', cfg.subjectName);
    setVal('input-pdf-subject-code', cfg.subjectCode);
    setVal('input-pdf-exam-date', cfg.examDateText);
    setVal('input-pdf-exam-time', cfg.examTimeText);
    setVal('select-pdf-choice-style', cfg.choiceStyle || 'AUTO');
    setChk('chk-pdf-include-q0', cfg.includeQuestionZero);

    setVal('input-pdf-author', cfg.authorText);
    setVal('input-pdf-posn-objective', cfg.posnObjectiveBox);

    setVal('input-pdf-set-number', cfg.setNumber);
    setVal('input-pdf-duration-override', cfg.durationMinutesOverride);
    setVal('textarea-pdf-alevel-cover-rules', cfg.alevelCoverRules);
    setVal('textarea-pdf-alevel-instructions', cfg.alevelInstructions);
    setVal('textarea-pdf-posn-rules', cfg.posnRules);
    setVal('textarea-pdf-copyright', cfg.copyrightNotice);

    setVal('input-pdf-barcode', cfg.barcodeValue);
    setVal('textarea-pdf-release-schedule', cfg.releaseScheduleText);
    setVal('input-pdf-qr-url', cfg.qrUrl);
    setVal('input-pdf-social-handle', cfg.socialHandle);
    setChk('chk-pdf-include-answer-key', cfg.includeAnswerKey);
  }

  function readConfigFromForm() {
    var prev = state.config || {};
    function getVal(id, fb) {
      var el = document.getElementById(id);
      return el ? String(el.value || '') : (fb || '');
    }
    function getChk(id, fb) {
      var el = document.getElementById(id);
      return el ? Boolean(el.checked) : Boolean(fb);
    }
    var op = Number(getVal('input-pdf-watermark-opacity', '10'));
    return {
      template: prev.template === 'posn' ? 'posn' : 'alevel',
      logoUrl: getVal('input-pdf-logo-url').trim(),
      bannerOrgName: getVal('input-pdf-banner-org').trim(),
      bannerMainTitle: getVal('input-pdf-banner-title').trim(),
      bannerRoundText: getVal('input-pdf-banner-round').trim(),
      bannerBadgeTop: getVal('input-pdf-badge-top').trim(),
      bannerBadgeNum: getVal('input-pdf-badge-num').trim(),
      posnEmblemShape: getVal('select-pdf-posn-emblem-shape', 'auto'),
      watermarkEnabled: getChk('chk-pdf-watermark-enabled', true),
      watermarkUrl: getVal('input-pdf-watermark-url').trim(),
      watermarkText: getVal('input-pdf-watermark-text').trim(),
      watermarkOpacity: isFinite(op) ? Math.max(4, Math.min(25, Math.round(op))) : 10,
      subjectName: getVal('input-pdf-subject-name').trim(),
      subjectCode: getVal('input-pdf-subject-code').trim(),
      examDateText: getVal('input-pdf-exam-date').trim(),
      examTimeText: getVal('input-pdf-exam-time').trim(),
      choiceStyle: getVal('select-pdf-choice-style', 'AUTO'),
      includeQuestionZero: getChk('chk-pdf-include-q0', true),
      authorText: getVal('input-pdf-author').trim(),
      posnObjectiveBox: getVal('input-pdf-posn-objective').trim(),
      setNumber: getVal('input-pdf-set-number').trim() || '1',
      durationMinutesOverride: getVal('input-pdf-duration-override').trim(),
      alevelCoverRules: getVal('textarea-pdf-alevel-cover-rules'),
      alevelInstructions: getVal('textarea-pdf-alevel-instructions'),
      posnRules: getVal('textarea-pdf-posn-rules'),
      copyrightNotice: getVal('textarea-pdf-copyright'),
      barcodeValue: getVal('input-pdf-barcode').trim(),
      releaseScheduleText: getVal('textarea-pdf-release-schedule'),
      qrUrl: getVal('input-pdf-qr-url').trim(),
      socialHandle: getVal('input-pdf-social-handle').trim(),
      socialCaption: prev.socialCaption || 'สอบถาม / อัปเดตข้อมูลได้ที่',
      includeAnswerKey: getChk('chk-pdf-include-answer-key', false),
      fontSizePt: 16
    };
  }

  function applyPreviewZoom() {
    var stage = document.getElementById('pdf-export-preview-stage');
    var viewport = document.getElementById('pdf-export-preview-viewport');
    if (!stage || !viewport) return;
    var a4Px = mmToPx(210);
    var availW = Math.max(280, viewport.clientWidth - 40);
    var scale = 0.65;
    if (state.zoom === 'fit') {
      scale = Math.min(0.92, Math.max(0.32, availW / a4Px));
    } else {
      scale = Number(state.zoom) || 0.65;
    }
    stage.style.transform = 'scale(' + scale.toFixed(3) + ')';
    stage.style.transformOrigin = 'top center';
    // Adjust wrapper height so scrolling matches scaled height cleanly
    var unscaledH = stage.scrollHeight || 0;
    var scalerWrap = document.getElementById('pdf-export-preview-scaler');
    if (scalerWrap && unscaledH > 0) {
      scalerWrap.style.height = Math.ceil(unscaledH * scale + 36) + 'px';
    }
  }

  async function renderLivePreview(opt_reloadFonts) {
    if (!state.exam) return;
    state.config = readConfigFromForm();
    var cfg = state.config;
    var stage = document.getElementById('pdf-export-preview-stage');
    var countBadge = document.getElementById('pdf-export-page-count-badge');
    var slot4Meta = document.getElementById('pdf-export-slot4-auto-meta');

    if (opt_reloadFonts) {
      setFontStatusPill(null);
      var fontRes = await loadPrivateFonts(cfg.template);
      setFontStatusPill(fontRes);
    }

    var assets = await preloadAllExamImageUrls(state.exam, cfg);
    var paged = paginateQuestionBlocks(state.exam, cfg, assets.fileUrlMap);
    var built = cfg.template === 'posn'
      ? buildPosnDocumentHtml(state.exam, cfg, assets, paged)
      : buildAlevelDocumentHtml(state.exam, cfg, assets, paged);

    state.lastPageCount = built.pagesHtml.length;
    state.lastContentPageCount = built.contentPages;
    state.lastPagesHtml = built.pagesHtml;

    if (stage) {
      stage.innerHTML = built.pagesHtml.join('');
    }
    if (countBadge) {
      countBadge.textContent = built.pagesHtml.length + ' A4 ' + (built.pagesHtml.length === 1 ? 'Page' : 'Pages');
    }
    if (slot4Meta) {
      var fullPts = formatExactBp(computeExactTotalPointsBp(state.exam));
      var dur = Number(cfg.durationMinutesOverride) > 0 ? Number(cfg.durationMinutesOverride) : (Number(state.exam.durationMinutes) || 90);
      slot4Meta.textContent =
        (cfg.template === 'posn'
          ? ('Auto: ' + built.contentPages + ' pages (excl. cover) • ')
          : ('Auto: ' + built.totalPages + ' pages total • ')) +
        paged.totalQuestions + ' questions • ' + fullPts + ' pts • ' + dur + ' min';
    }

    setTimeout(applyPreviewZoom, 30);
    return built;
  }

  function schedulePreviewRefresh() {
    if (state.previewTimer) clearTimeout(state.previewTimer);
    state.previewTimer = setTimeout(function () {
      renderLivePreview(false).catch(function (e) {
        console.error('PDF preview refresh error:', e);
      });
    }, 180);
  }

  async function savePdfConfigToSupabase(silent) {
    if (!state.exam || !state.exam.examSetId) return;
    state.config = readConfigFromForm();
    var saveBtn = document.getElementById('btn-pdf-export-save-config');
    var statusEl = document.getElementById('pdf-export-save-status');
    if (saveBtn) saveBtn.disabled = true;
    if (statusEl) statusEl.textContent = 'Saving...';
    try {
      var token = '';
      if (global.PB_API && typeof global.PB_API.dispatchDirect === 'function') {
        try {
          token = (window.sessionStorage && window.sessionStorage.getItem('pb_session_token_v1')) ||
                  (window.localStorage && window.localStorage.getItem('pb_session_token_v1')) || '';
        } catch (_eT) {}
        // Prefer in-app RPC helper if exposed
        var res;
        if (typeof global.__pbRpcCallEnvelope === 'function') {
          res = await global.__pbRpcCallEnvelope('admin.exams.savePdfConfig', {
            examSetId: state.exam.examSetId,
            pdfConfig: state.config
          });
        } else {
          res = await global.PB_API.dispatchDirect({
            action: 'admin.exams.savePdfConfig',
            payload: { examSetId: state.exam.examSetId, pdfConfig: state.config },
            sessionToken: token
          });
          if (res && res.ok === false) throw new Error((res.error && res.error.message) || 'Save failed');
        }
        state.exam.pdfConfig = Object.assign({}, state.config);
        if (typeof state.onConfigSaved === 'function') {
          state.onConfigSaved(state.exam.examSetId, state.exam.pdfConfig);
        }
        if (statusEl) statusEl.textContent = 'Saved to Supabase';
        if (!silent && global.PBNotify && typeof global.PBNotify.toast === 'function') {
          global.PBNotify.toast('success', 'PDF Settings Saved', 'Template and Slots 1–5 saved for this exam.');
        }
      }
    } catch (err) {
      if (statusEl) statusEl.textContent = 'Save failed';
      if (!silent && global.PBNotify && typeof global.PBNotify.toast === 'function') {
        global.PBNotify.toast('danger', 'Failed to Save PDF Config', (err && err.message) || 'Unknown error.');
      }
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  function waitForAllImages(rootEl) {
    var imgs = rootEl ? Array.prototype.slice.call(rootEl.querySelectorAll('img')) : [];
    if (imgs.length === 0) return Promise.resolve();
    return Promise.all(imgs.map(function (img) {
      return new Promise(function (resolve) {
        if (img.complete && img.naturalWidth > 0) return resolve();
        var done = false;
        var finish = function () { if (!done) { done = true; resolve(); } };
        img.addEventListener('load', finish, { once: true });
        img.addEventListener('error', finish, { once: true });
        setTimeout(finish, 4500);
      });
    }));
  }

  async function triggerPrintExport() {
    if (!state.exam || state.isPrinting) return;
    state.isPrinting = true;
    var printBtn = document.getElementById('btn-pdf-export-print');
    var origHtml = printBtn ? printBtn.innerHTML : '';
    if (printBtn) {
      printBtn.disabled = true;
      printBtn.textContent = 'Preparing A4 PDF...';
    }

    try {
      // 1. Persist latest config quietly
      await savePdfConfigToSupabase(true);

      // 2. Ensure private web fonts are loaded & ready
      var fontRes = await loadPrivateFonts(state.config.template);
      setFontStatusPill(fontRes);
      if (document.fonts && document.fonts.ready) {
        await document.fonts.ready;
      }

      // 3. Re-measure & re-paginate with final loaded fonts for 100% accurate Slot 4 page counts
      var built = await renderLivePreview(false);

      // 4. Populate isolated #pb-pdf-print-root
      var printRoot = document.getElementById('pb-pdf-print-root');
      if (!printRoot) {
        printRoot = document.createElement('div');
        printRoot.id = 'pb-pdf-print-root';
        printRoot.setAttribute('aria-hidden', 'true');
        document.body.appendChild(printRoot);
      }
      printRoot.className = 'pb-pdf-doc pb-pdf-tpl-' + state.config.template;
      printRoot.innerHTML = built.pagesHtml.join('');

      // 5. Wait for every logo, watermark, QR, and question image to decode before print
      await waitForAllImages(printRoot);
      await new Promise(function (r) { setTimeout(r, 80); });

      // 6. Auto-name exported PDF via document.title & trigger native browser Print -> Save as PDF
      var originalTitle = document.title;
      var autoPdfTitle = buildCleanPdfFilename(state.exam, state.config);
      document.title = autoPdfTitle;
      document.body.classList.add('pb-pdf-printing-active');
      var restored = false;
      var cleanup = function () {
        if (restored) return;
        restored = true;
        document.body.classList.remove('pb-pdf-printing-active');
        document.title = originalTitle;
        window.removeEventListener('afterprint', cleanup);
      };
      window.addEventListener('afterprint', cleanup);
      window.print();
      setTimeout(cleanup, 1500);
    } catch (err) {
      if (global.PBNotify && typeof global.PBNotify.toast === 'function') {
        global.PBNotify.toast('danger', 'PDF Export Error', (err && err.message) || 'Could not prepare printable PDF.');
      }
    } finally {
      state.isPrinting = false;
      if (printBtn) {
        printBtn.disabled = false;
        printBtn.innerHTML = origHtml;
      }
    }
  }

  function bindModalEventsOnce() {
    if (state.modalBound) return;
    state.modalBound = true;

    function onClick(id, fn) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('click', fn);
    }

    onClick('btn-pdf-export-close', closeModal);
    onClick('btn-pdf-export-cancel', closeModal);

    onClick('btn-pdf-tpl-alevel', function () {
      if (!state.config) return;
      state.config.template = 'alevel';
      syncTemplateFieldVisibility('alevel');
      renderLivePreview(true);
    });
    onClick('btn-pdf-tpl-posn', function () {
      if (!state.config) return;
      state.config.template = 'posn';
      syncTemplateFieldVisibility('posn');
      renderLivePreview(true);
    });

    onClick('btn-pdf-use-school-logo', function () {
      var inp = document.getElementById('input-pdf-logo-url');
      if (inp) inp.value = DEFAULT_LOGO_PATH;
      schedulePreviewRefresh();
    });

    var logoFileInp = document.getElementById('file-pdf-logo-upload');
    if (logoFileInp) {
      logoFileInp.addEventListener('change', async function () {
        var f = logoFileInp.files && logoFileInp.files[0];
        if (!f) return;
        try {
          var uri = await uploadAssetToSupabase(f, 'logo');
          var inp = document.getElementById('input-pdf-logo-url');
          if (inp) inp.value = uri;
          renderLivePreview(false);
          if (global.PBNotify) global.PBNotify.toast('success', 'Logo Uploaded', 'Saved to Supabase exam-pdf-assets bucket.');
        } catch (err) {
          if (global.PBNotify) global.PBNotify.toast('danger', 'Logo Upload Failed', (err && err.message) || 'Upload error');
        } finally {
          logoFileInp.value = '';
        }
      });
    }

    var wmFileInp = document.getElementById('file-pdf-watermark-upload');
    if (wmFileInp) {
      wmFileInp.addEventListener('change', async function () {
        var f = wmFileInp.files && wmFileInp.files[0];
        if (!f) return;
        try {
          var uri = await uploadAssetToSupabase(f, 'watermark');
          var inp = document.getElementById('input-pdf-watermark-url');
          if (inp) inp.value = uri;
          renderLivePreview(false);
          if (global.PBNotify) global.PBNotify.toast('success', 'Watermark Uploaded', 'Saved to Supabase exam-pdf-assets bucket.');
        } catch (err) {
          if (global.PBNotify) global.PBNotify.toast('danger', 'Watermark Upload Failed', (err && err.message) || 'Upload error');
        } finally {
          wmFileInp.value = '';
        }
      });
    }

    var opSlider = document.getElementById('input-pdf-watermark-opacity');
    if (opSlider) {
      opSlider.addEventListener('input', function () {
        var lbl = document.getElementById('label-pdf-watermark-opacity');
        if (lbl) lbl.textContent = String(opSlider.value) + '%';
        schedulePreviewRefresh();
      });
    }

    var form = document.getElementById('form-exam-pdf-export');
    if (form) {
      form.addEventListener('input', schedulePreviewRefresh);
      form.addEventListener('change', schedulePreviewRefresh);
      form.addEventListener('submit', function (evt) {
        evt.preventDefault();
        triggerPrintExport();
      });
    }

    onClick('btn-pdf-export-save-config', function () {
      savePdfConfigToSupabase(false);
    });
    onClick('btn-pdf-export-print', function () {
      triggerPrintExport();
    });
    onClick('btn-pdf-export-refresh-preview', function () {
      renderLivePreview(false);
    });
    onClick('btn-pdf-export-reset-defaults', function () {
      if (!state.exam) return;
      var curTpl = state.config ? state.config.template : 'alevel';
      var cloneEx = Object.assign({}, state.exam, { pdfConfig: {} });
      state.config = buildDefaultConfig(cloneEx, state.schoolMeta);
      state.config.template = curTpl;
      populateFormFromConfig(state.config);
      renderLivePreview(true);
    });

    var zoomBtns = document.querySelectorAll('[data-pdf-zoom]');
    for (var z = 0; z < zoomBtns.length; z++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          state.zoom = btn.getAttribute('data-pdf-zoom') || 'fit';
          for (var k = 0; k < zoomBtns.length; k++) {
            zoomBtns[k].classList.toggle('is-active', zoomBtns[k] === btn);
          }
          applyPreviewZoom();
        });
      })(zoomBtns[z]);
    }

    window.addEventListener('resize', function () {
      var modal = document.getElementById('modal-exam-pdf-export');
      if (modal && !modal.classList.contains('hidden')) {
        applyPreviewZoom();
      }
    });
  }

  function closeModal() {
    var modal = document.getElementById('modal-exam-pdf-export');
    if (modal) {
      modal.classList.add('hidden');
      modal.setAttribute('aria-hidden', 'true');
    }
    if (document.body) {
      document.body.classList.remove('pb-modal-open');
    }
  }

  async function openModal(examDto, opts) {
    if (!examDto) return;
    bindModalEventsOnce();
    var o = opts && typeof opts === 'object' ? opts : {};
    state.exam = examDto;
    state.schoolMeta = o.schoolMeta || {};
    state.onConfigSaved = typeof o.onConfigSaved === 'function' ? o.onConfigSaved : null;
    state.config = buildDefaultConfig(examDto, state.schoolMeta);

    var titleEl = document.getElementById('pdf-export-modal-exam-title');
    if (titleEl) {
      titleEl.textContent = (examDto.examCode ? '[' + examDto.examCode + '] ' : '') + (examDto.title || 'Exam PDF Export');
    }
    var statusEl = document.getElementById('pdf-export-save-status');
    if (statusEl) statusEl.textContent = '';

    populateFormFromConfig(state.config);

    var modal = document.getElementById('modal-exam-pdf-export');
    if (modal) {
      modal.classList.remove('hidden');
      modal.setAttribute('aria-hidden', 'false');
    }
    if (document.body) {
      document.body.classList.add('pb-modal-open');
    }

    await renderLivePreview(true);
  }

  global.PBExamPdfExport = {
    openModal: openModal,
    closeModal: closeModal,
    loadPrivateFonts: loadPrivateFonts,
    renderLivePreview: renderLivePreview,
    triggerPrintExport: triggerPrintExport,
    buildCleanPdfFilename: buildCleanPdfFilename,
    PRIVATE_FONT_MANIFEST: PRIVATE_FONT_MANIFEST
  };
})(window);
