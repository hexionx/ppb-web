/**
 * RichTextService.gs
 * Pattanabhumi Biology Learning Management System - Step 7 Structured Rich-Text Engine
 *
 * Responsibilities:
 * - Validate, normalize, and serialize structured JSON rich-text documents (`pb-richtext-v1`).
 * - Enforce Google Sheets cell storage budgets (<= 30,000 characters per serialized JSON field).
 * - Enforce strict server-side allowlists on:
 *     1. Document schema version (`pb-richtext-v1`)
 *     2. Block node types (`paragraph`, `bullet_list`, `ordered_list`; with `image_attachment`
 *        and `pdf_attachment` reserved and gated until the Private Drive File Storage step)
 *     3. Maximum block count (<= 150 blocks), list item count (<= 50 items per list),
 *        inline span count (<= 60 spans per paragraph/item), and nesting depth (flat blocks,
 *        no nested lists inside list items)
 *     4. Inline marks (`bold`, `italic`, `underline`, `size` in `['sm', 'base', 'lg', 'xl']`,
 *        and `link` restricted strictly to `https://` or `mailto:` URLs)
 * - Reject raw HTML strings, script tags, or unsafe URL schemes (`javascript:`, `data:`,
 *   `vbscript:`, `file:`, `http://`) with structured `ERR_VALIDATION_FAILED` field errors.
 *
 * Security Note:
 * - Every function in this file ends with an underscore (_) so it cannot be called
 *   directly from browser clients via google.script.run.
 */

var PB_RICHTEXT_SCHEMA_VERSION_ = 'pb-richtext-v1';
var PB_RICHTEXT_MAX_JSON_CHARS_ = 30000;
var PB_RICHTEXT_MAX_BLOCKS_ = 150;
var PB_RICHTEXT_MAX_LIST_ITEMS_ = 50;
var PB_RICHTEXT_MAX_SPANS_PER_BLOCK_ = 60;
var PB_RICHTEXT_MAX_SPAN_TEXT_CHARS_ = 4000;

var PB_RICHTEXT_ALLOWED_BLOCK_TYPES_ = Object.freeze({
  paragraph: true,
  bullet_list: true,
  ordered_list: true,
  image_attachment: true,
  pdf_attachment: true,
  table: true
});

var PB_RICHTEXT_ALLOWED_FONT_SIZES_ = Object.freeze({
  sm: true,
  base: true,
  lg: true,
  xl: true
});

/**
 * Sanitizes a single-line plain text input by stripping NULL/control characters,
 * collapsing internal newlines to spaces, trimming, and enforcing a max character limit.
 *
 * @param {*} rawInput Candidate input value.
 * @param {number} maxLength Maximum character length.
 * @return {string} Cleaned single-line string.
 */
function sanitizeSingleLineTextStep7_(rawInput, maxLength) {
  if (rawInput === null || rawInput === undefined) {
    return '';
  }
  var s = String(rawInput)
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (maxLength && s.length > maxLength) {
    s = s.slice(0, maxLength).trim();
  }
  return s;
}
/**
 * Validates a rich-text hyperlink URL.
 * Only `https://` web URLs and `mailto:` email links are permitted.
 *
 * @param {string} rawUrl Candidate link URL.
 * @return {{ok: boolean, url: string, message?: string}} Validation result.
 */
function validateRichTextLinkUrl_(rawUrl) {
  if (rawUrl === null || rawUrl === undefined || String(rawUrl).trim() === '') {
    return { ok: true, url: '' };
  }
  var trimmed = String(rawUrl).trim();
  if (trimmed.length > 500) {
    return {
      ok: false,
      url: '',
      message: 'Rich-text hyperlink URL must not exceed 500 characters.'
    };
  }
  if (/[\s\u0000-\u001F\u007F]/.test(trimmed)) {
    return {
      ok: false,
      url: '',
      message:
        'Rich-text hyperlink URL must not contain whitespace or control characters.'
    };
  }
  if (/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[^\s]*)?$/i.test(trimmed)) {
    return { ok: true, url: trimmed };
  }
  if (/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(trimmed)) {
    return { ok: true, url: trimmed };
  }
  return {
    ok: false,
    url: '',
    message:
      'Rich-text hyperlink URL must begin with https:// or mailto: (javascript:, data:, and insecure http:// links are prohibited).'
  };
}
/**
 * Normalizes and validates an array of inline text spans within a paragraph or list item.
 *
 * @param {Array<Object>} rawSpans Candidate inline spans array.
 * @param {string} fieldKey Field key for structured error reporting.
 * @param {string} blockPath Human-readable block path for error messages.
 * @param {Object} fieldErrors Mutable map of field errors.
 * @return {Array<Object>} Normalized array of inline spans.
 */
function validateAndNormalizeRichTextSpans_(
  rawSpans,
  fieldKey,
  blockPath,
  fieldErrors
) {
  if (!Array.isArray(rawSpans)) {
    fieldErrors[fieldKey] = blockPath + ': inline spans must be an array.';
    return [{ text: '' }];
  }
  if (rawSpans.length === 0) {
    return [{ text: '' }];
  }
  if (rawSpans.length > PB_RICHTEXT_MAX_SPANS_PER_BLOCK_) {
    fieldErrors[fieldKey] =
      blockPath +
      ': exceeds maximum of ' +
      PB_RICHTEXT_MAX_SPANS_PER_BLOCK_ +
      ' inline formatting spans per block.';
    return [{ text: '' }];
  }

  var normalizedSpans = [];
  for (var i = 0; i < rawSpans.length; i++) {
    var rawSpan = rawSpans[i];
    if (!rawSpan || typeof rawSpan !== 'object' || Array.isArray(rawSpan)) {
      fieldErrors[fieldKey] =
        blockPath + ' span[' + i + ']: must be a structured span object.';
      continue;
    }

    var spanKeys = Object.keys(rawSpan);
    for (var k = 0; k < spanKeys.length; k++) {
      var keyName = spanKeys[k];
      if (
        keyName !== 'text' &&
        keyName !== 'bold' &&
        keyName !== 'italic' &&
        keyName !== 'underline' &&
        keyName !== 'sup' &&
        keyName !== 'sub' &&
        keyName !== 'size' &&
        keyName !== 'link'
      ) {
        fieldErrors[fieldKey] =
          blockPath +
          ' span[' +
          i +
          ']: unsupported inline mark or property "' +
          keyName +
          '".';
      }
    }

    var textVal =
      rawSpan.text === null || rawSpan.text === undefined
        ? ''
        : String(rawSpan.text);
    textVal = textVal
      .replace(/\u0000/g, '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');

    if (textVal.length > PB_RICHTEXT_MAX_SPAN_TEXT_CHARS_) {
      fieldErrors[fieldKey] =
        blockPath +
        ' span[' +
        i +
        ']: text exceeds maximum of ' +
        PB_RICHTEXT_MAX_SPAN_TEXT_CHARS_ +
        ' characters per span.';
    }

    var cleanSpan = {
      text: textVal
    };

    if (rawSpan.bold === true) {
      cleanSpan.bold = true;
    }
    if (rawSpan.italic === true) {
      cleanSpan.italic = true;
    }
    if (rawSpan.underline === true) {
      cleanSpan.underline = true;
    }
    if (rawSpan.sup === true && rawSpan.sub === true) {
      fieldErrors[fieldKey] =
        blockPath + ' span[' + i + ']: cannot set both sup and sub on the same span.';
    } else if (rawSpan.sup === true) {
      cleanSpan.sup = true;
    } else if (rawSpan.sub === true) {
      cleanSpan.sub = true;
    }

    if (
      rawSpan.size !== undefined &&
      rawSpan.size !== null &&
      rawSpan.size !== ''
    ) {
      var sizeStr = String(rawSpan.size).trim();
      if (!PB_RICHTEXT_ALLOWED_FONT_SIZES_[sizeStr]) {
        fieldErrors[fieldKey] =
          blockPath +
          ' span[' +
          i +
          ']: unsupported font size "' +
          sizeStr +
          '" (allowed: sm, base, lg, xl).';
      } else if (sizeStr !== 'base') {
        cleanSpan.size = sizeStr;
      }
    }

    if (
      rawSpan.link !== undefined &&
      rawSpan.link !== null &&
      String(rawSpan.link).trim() !== ''
    ) {
      var linkCheck = validateRichTextLinkUrl_(rawSpan.link);
      if (!linkCheck.ok) {
        fieldErrors[fieldKey] =
          blockPath + ' span[' + i + ']: ' + linkCheck.message;
      } else if (linkCheck.url) {
        cleanSpan.link = linkCheck.url;
      }
    }

    normalizedSpans.push(cleanSpan);
  }

  if (normalizedSpans.length === 0) {
    normalizedSpans.push({ text: '' });
  }
  return normalizedSpans;
}
/**
 * Converts a plain-text string into a valid `pb-richtext-v1` document object.
 *
 * @param {string} plainText Input text.
 * @return {Object} Structured `pb-richtext-v1` document object.
 */
function plainTextToRichTextDoc_(plainText) {
  var raw =
    plainText === null || plainText === undefined ? '' : String(plainText);
  raw = raw
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
  if (!raw) {
    return {
      schemaVersion: PB_RICHTEXT_SCHEMA_VERSION_,
      blocks: [
        {
          type: 'paragraph',
          spans: [{ text: '' }]
        }
      ]
    };
  }

  var lines = raw.split(/\n+/);
  var blocks = [];
  for (var i = 0; i < lines.length && i < PB_RICHTEXT_MAX_BLOCKS_; i++) {
    var lineText = lines[i].slice(0, PB_RICHTEXT_MAX_SPAN_TEXT_CHARS_);
    blocks.push({
      type: 'paragraph',
      spans: [{ text: lineText }]
    });
  }
  if (blocks.length === 0) {
    blocks.push({
      type: 'paragraph',
      spans: [{ text: '' }]
    });
  }
  return {
    schemaVersion: PB_RICHTEXT_SCHEMA_VERSION_,
    blocks: blocks
  };
}
/**
 * Converts plain text into a serialized `pb-richtext-v1` JSON string.
 *
 * @param {string} plainText Input text.
 * @return {string} Serialized JSON string.
 */
function plainTextToRichTextJson_(plainText) {
  return JSON.stringify(plainTextToRichTextDoc_(plainText));
}
/**
 * Validates and normalizes a `pb-richtext-v1` input (either an already-parsed object,
 * a JSON string, or null/empty when optional).
 *
 * @param {Object|string} rawInput Candidate rich-text document object or JSON string.
 * @param {string} fieldKey Field identifier for `fieldErrors` (e.g., `contentRichText`).
 * @param {string} fieldLabel Human-readable label for error messages.
 * @param {boolean=} opt_requireNonEmpty If true, requires at least one non-whitespace character.
 * @return {{doc: Object, json: string, plainTextSummary: string}} Validated rich-text bundle.
 */
function validateAndNormalizeRichTextInput_(
  rawInput,
  fieldKey,
  fieldLabel,
  opt_requireNonEmpty
) {
  var fieldErrors = {};
  var key = fieldKey || 'richText';
  var label = fieldLabel || 'Rich text content';
  var parsedDoc = null;

  if (rawInput === null || rawInput === undefined || rawInput === '') {
    parsedDoc = plainTextToRichTextDoc_('');
  } else if (typeof rawInput === 'string') {
    var trimmedStr = rawInput.trim();
    if (!trimmedStr) {
      parsedDoc = plainTextToRichTextDoc_('');
    } else if (
      trimmedStr.charAt(0) === '<' &&
      /<\/?[a-z][\s\S]*>/i.test(trimmedStr)
    ) {
      fieldErrors[key] =
        label +
        ' must be a structured pb-richtext-v1 JSON document, not raw HTML markup.';
      throw createAppError_(
        PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
        label + ' rejected: arbitrary raw HTML is not allowed.',
        fieldErrors
      );
    } else if (trimmedStr.charAt(0) === '{') {
      try {
        parsedDoc = JSON.parse(trimmedStr);
      } catch (parseErr) {
        fieldErrors[key] =
          label +
          ' contains invalid JSON (' +
          String(parseErr.message || parseErr) +
          ').';
        throw createAppError_(
          PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
          label + ' contains malformed rich-text JSON.',
          fieldErrors
        );
      }
    } else {
      parsedDoc = plainTextToRichTextDoc_(trimmedStr);
    }
  } else if (typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    parsedDoc = rawInput;
  } else {
    fieldErrors[key] = label + ' must be a structured pb-richtext-v1 object.';
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      label + ' has an invalid data type.',
      fieldErrors
    );
  }

  if (!parsedDoc || parsedDoc.schemaVersion !== PB_RICHTEXT_SCHEMA_VERSION_) {
    fieldErrors[key] =
      label +
      ' must declare schemaVersion "' +
      PB_RICHTEXT_SCHEMA_VERSION_ +
      '".';
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      label + ' schemaVersion is invalid or unsupported.',
      fieldErrors
    );
  }

  if (!Array.isArray(parsedDoc.blocks)) {
    fieldErrors[key] = label + ' must include a "blocks" array.';
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      label + ' blocks array is missing.',
      fieldErrors
    );
  }

  if (parsedDoc.blocks.length > PB_RICHTEXT_MAX_BLOCKS_) {
    fieldErrors[key] =
      label +
      ' exceeds the maximum of ' +
      PB_RICHTEXT_MAX_BLOCKS_ +
      ' blocks per document.';
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      label + ' has too many blocks.',
      fieldErrors
    );
  }

  var normalizedBlocks = [];
  var plainTextParts = [];

  for (var bIdx = 0; bIdx < parsedDoc.blocks.length; bIdx++) {
    var rawBlock = parsedDoc.blocks[bIdx];
    var blockPath = label + ' block[' + bIdx + ']';
    if (!rawBlock || typeof rawBlock !== 'object' || Array.isArray(rawBlock)) {
      fieldErrors[key] = blockPath + ' must be a structured block object.';
      continue;
    }

    var bType = String(rawBlock.type || '').trim();
    if (!PB_RICHTEXT_ALLOWED_BLOCK_TYPES_[bType]) {
      fieldErrors[key] =
        blockPath +
        ': unsupported block type "' +
        bType +
        '" (allowed: paragraph, bullet_list, ordered_list, image_attachment, pdf_attachment).';
      continue;
    }

    if (bType === 'paragraph') {
      var normSpans = validateAndNormalizeRichTextSpans_(
        rawBlock.spans,
        key,
        blockPath,
        fieldErrors
      );
      var paraText = '';
      for (var sIdx = 0; sIdx < normSpans.length; sIdx++) {
        paraText += normSpans[sIdx].text;
      }
      if (paraText.trim()) {
        plainTextParts.push(paraText.trim());
      }
      normalizedBlocks.push({
        type: 'paragraph',
        spans: normSpans
      });
    } else if (bType === 'bullet_list' || bType === 'ordered_list') {
      if (!Array.isArray(rawBlock.items) || rawBlock.items.length === 0) {
        fieldErrors[key] =
          blockPath +
          ' (' +
          bType +
          ') must contain a non-empty "items" array.';
        continue;
      }
      if (rawBlock.items.length > PB_RICHTEXT_MAX_LIST_ITEMS_) {
        fieldErrors[key] =
          blockPath +
          ' exceeds maximum of ' +
          PB_RICHTEXT_MAX_LIST_ITEMS_ +
          ' list items.';
        continue;
      }

      var normItems = [];
      for (var itemIdx = 0; itemIdx < rawBlock.items.length; itemIdx++) {
        var rawItem = rawBlock.items[itemIdx];
        var itemPath = blockPath + ' item[' + itemIdx + ']';
        if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
          fieldErrors[key] =
            itemPath + ' must be a structured list_item object.';
          continue;
        }
        if (rawItem.items !== undefined || rawItem.blocks !== undefined) {
          fieldErrors[key] =
            itemPath +
            ': nested lists or nested blocks inside list items are not permitted.';
          continue;
        }
        var itemSpans = validateAndNormalizeRichTextSpans_(
          rawItem.spans,
          key,
          itemPath,
          fieldErrors
        );
        var itemText = '';
        for (var isIdx = 0; isIdx < itemSpans.length; isIdx++) {
          itemText += itemSpans[isIdx].text;
        }
        if (itemText.trim()) {
          plainTextParts.push(itemText.trim());
        }
        normItems.push({
          type: 'list_item',
          spans: itemSpans
        });
      }

      normalizedBlocks.push({
        type: bType,
        items: normItems
      });
    } else if (bType === 'image_attachment') {
      var imgFileId = sanitizeSingleLineTextStep7_(rawBlock.fileId, 80);
      if (!imgFileId) {
        fieldErrors[key] =
          blockPath + ' (image_attachment): fileId is required.';
        continue;
      }
      if (/^(blob:|data:|https?:)/i.test(imgFileId)) {
        fieldErrors[key] =
          blockPath +
          ' (image_attachment): temporary blob:/data:/http URLs cannot be persisted as database references. Provide an application file_id (fil_...).';
        continue;
      }
      if (!/^fil_[A-Za-z0-9_-]{4,64}$/.test(imgFileId)) {
        fieldErrors[key] =
          blockPath +
          ' (image_attachment): fileId must be a valid application file reference (fil_...).';
        continue;
      }
      var imgAlt = sanitizeSingleLineTextStep7_(
        rawBlock.altText !== undefined ? rawBlock.altText : rawBlock.caption,
        240
      );
      var imgCaption = sanitizeSingleLineTextStep7_(rawBlock.caption, 300);
      if (imgCaption) {
        plainTextParts.push('[Image: ' + imgCaption + ']');
      } else {
        plainTextParts.push('[Image: ' + imgFileId + ']');
      }
      normalizedBlocks.push({
        type: 'image_attachment',
        fileId: imgFileId,
        altText: imgAlt || 'Course diagram',
        caption: imgCaption
      });
    } else if (bType === 'pdf_attachment') {
      var pdfFileId = sanitizeSingleLineTextStep7_(rawBlock.fileId, 80);
      if (!pdfFileId) {
        fieldErrors[key] =
          blockPath + ' (pdf_attachment): fileId is required.';
        continue;
      }
      if (/^(blob:|data:|https?:)/i.test(pdfFileId)) {
        fieldErrors[key] =
          blockPath +
          ' (pdf_attachment): temporary blob:/data:/http URLs cannot be persisted as database references. Provide an application file_id (fil_...).';
        continue;
      }
      if (!/^fil_[A-Za-z0-9_-]{4,64}$/.test(pdfFileId)) {
        fieldErrors[key] =
          blockPath +
          ' (pdf_attachment): fileId must be a valid application file reference (fil_...).';
        continue;
      }
      var pdfTitle =
        sanitizeSingleLineTextStep7_(rawBlock.title, 200) ||
        'Course PDF Handout';
      plainTextParts.push('[PDF: ' + pdfTitle + ']');
      normalizedBlocks.push({
        type: 'pdf_attachment',
        fileId: pdfFileId,
        title: pdfTitle
      });
    } else if (bType === 'table') {
      var tblCaption = sanitizeSingleLineTextStep7_(rawBlock.caption, 240);
      var rawHeaders = Array.isArray(rawBlock.headers) ? rawBlock.headers : [];
      var rawRows = Array.isArray(rawBlock.rows) ? rawBlock.rows : [];
      if (rawRows.length === 0 || rawRows.length > 25) {
        fieldErrors[key] =
          blockPath + ' (table): must contain between 1 and 25 rows.';
        continue;
      }
      var colCount = rawHeaders.length > 0 ? rawHeaders.length : (Array.isArray(rawRows[0]) ? rawRows[0].length : 0);
      if (colCount < 1 || colCount > 10) {
        fieldErrors[key] =
          blockPath + ' (table): must contain between 1 and 10 columns.';
        continue;
      }
      var normHeaders = [];
      if (rawHeaders.length > 0) {
        if (rawHeaders.length !== colCount) {
          fieldErrors[key] = blockPath + ' (table): header column count mismatch.';
          continue;
        }
        for (var hIdx = 0; hIdx < rawHeaders.length; hIdx++) {
          var hCell = sanitizeSingleLineTextStep7_(rawHeaders[hIdx], 200);
          if (/<\/?[a-z][\s\S]*>/i.test(hCell)) {
            fieldErrors[key] = blockPath + ' (table): raw HTML is not allowed in table headers.';
          }
          normHeaders.push(hCell);
          if (hCell) plainTextParts.push(hCell);
        }
      }
      var normRows = [];
      for (var rIdx = 0; rIdx < rawRows.length; rIdx++) {
        var rArr = rawRows[rIdx];
        if (!Array.isArray(rArr) || rArr.length !== colCount) {
          fieldErrors[key] =
            blockPath + ' (table): row[' + rIdx + '] must have exactly ' + colCount + ' columns.';
          continue;
        }
        var cleanRow = [];
        for (var cIdx = 0; cIdx < rArr.length; cIdx++) {
          var cellVal = sanitizeSingleLineTextStep7_(rArr[cIdx], 300);
          if (/<\/?[a-z][\s\S]*>/i.test(cellVal)) {
            fieldErrors[key] =
              blockPath + ' (table): raw HTML is not allowed in table cells.';
          }
          cleanRow.push(cellVal);
          if (cellVal) plainTextParts.push(cellVal);
        }
        normRows.push(cleanRow);
      }
      if (tblCaption) {
        plainTextParts.push('[Table: ' + tblCaption + ']');
      }
      normalizedBlocks.push({
        type: 'table',
        caption: tblCaption,
        headers: normHeaders,
        rows: normRows
      });
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Please correct the rich-text validation errors in ' + label + '.',
      fieldErrors
    );
  }

  if (normalizedBlocks.length === 0) {
    normalizedBlocks.push({
      type: 'paragraph',
      spans: [{ text: '' }]
    });
  }

  var plainTextSummary = plainTextParts.join(' ').trim();
  if (opt_requireNonEmpty && !plainTextSummary) {
    fieldErrors[key] = label + ' cannot be empty.';
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      label + ' is required and cannot be blank.',
      fieldErrors
    );
  }

  var finalDoc = {
    schemaVersion: PB_RICHTEXT_SCHEMA_VERSION_,
    blocks: normalizedBlocks
  };
  var serializedJson = JSON.stringify(finalDoc);

  if (serializedJson.length > PB_RICHTEXT_MAX_JSON_CHARS_) {
    fieldErrors[key] =
      label +
      ' serialized rich-text JSON length (' +
      serializedJson.length +
      ' chars) exceeds the Google Sheets cell safety limit of ' +
      PB_RICHTEXT_MAX_JSON_CHARS_ +
      ' characters.';
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      label + ' exceeds the maximum 30,000-character cell storage size.',
      fieldErrors
    );
  }

  return {
    doc: finalDoc,
    json: serializedJson,
    plainTextSummary: plainTextSummary
  };
}
/**
 * Safely parses a stored `pb-richtext-v1` JSON string from a Google Sheet cell
 * into a normalized document object for client rendering.
 *
 * @param {string} storedJson Raw string from sheet cell.
 * @return {Object} Normalized `pb-richtext-v1` document object.
 */
function parseStoredRichTextJsonSafe_(storedJson) {
  if (!storedJson || typeof storedJson !== 'string' || !storedJson.trim()) {
    return plainTextToRichTextDoc_('');
  }
  var trimmed = storedJson.trim();
  if (trimmed.charAt(0) === '{') {
    try {
      var parsed = JSON.parse(trimmed);
      if (
        parsed &&
        parsed.schemaVersion === PB_RICHTEXT_SCHEMA_VERSION_ &&
        Array.isArray(parsed.blocks)
      ) {
        return parsed;
      }
    } catch (ignoreErr) {}
  }
  return plainTextToRichTextDoc_(trimmed);
}