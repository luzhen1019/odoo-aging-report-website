/* Aging analysis engine — browser port of services/parser.py and
   models/aging_line.py. Pure functions, no DOM. Attaches window.AgingEngine. */
(function (root) {
  'use strict';

  var DEFAULT_TERM_DAYS = 30;
  var MAX_HEADER_SCAN = 10;
  var DEFAULT_HIGH_RISK_AMOUNT = 100000;

  var BUCKETS = [
    { key: 'not_due', label: '未到期' },
    { key: 'd0_30', label: '0-30天' },
    { key: 'd30_60', label: '30-60天' },
    { key: 'd60_90', label: '60-90天' },
    { key: 'd90_plus', label: '90天以上' }
  ];
  var RISK_LEVELS = [
    { key: 'normal', label: '正常' },
    { key: 'watch', label: '关注' },
    { key: 'high', label: '高风险' }
  ];
  var BUCKET_LABELS = {};
  BUCKETS.forEach(function (b) { BUCKET_LABELS[b.key] = b.label; });
  var RISK_LABELS = {};
  RISK_LEVELS.forEach(function (r) { RISK_LABELS[r.key] = r.label; });

  var HEADER_SYNONYMS = {
    partner_name: ['客户名称', '客户全称', '客户', '供应商名称', '供应商全称', '供应商',
      '往来单位名称', '往来单位', '单位名称', '往来客户', '客商名称',
      'partner', 'partner_name', 'customer', 'supplier', 'customer_name'],
    partner_ref: ['客户编码', '客户编号', '供应商编码', '供应商编号', '客商编码',
      '往来单位编码', '单位编码', '编码', '客户代码', '供应商代码',
      'partner_ref', 'partner_code', 'customer_code', 'supplier_code'],
    doc_no: ['单据编号', '单据号', '单据编码', '发票号', '发票号码', '单号', '凭证号',
      'doc_no', 'invoice_no', 'invoice_number', 'bill_no'],
    doc_date: ['单据日期', '发票日期', '开票日期', '业务日期', '挂账日期',
      'doc_date', 'invoice_date', 'bill_date'],
    due_date: ['到期日', '到期日期', '付款到期日', '应收到期日', '应付到期日',
      '账期到期日', '收款到期日', '付款日期', 'due_date', 'due'],
    term_days: ['账期', '账期天数', '信用期', '信用天数', '付款期限', '收款期限',
      'term_days', 'term', 'credit_days'],
    amount: ['应收金额', '应付金额', '原始金额', '开票金额', '价税合计', '合计金额',
      '应收/应付金额', '金额', 'amount', 'total_amount', 'invoice_amount'],
    paid_amount: ['已收金额', '已付金额', '已收款', '已付款', '已收', '已付',
      '收款金额', '付款金额', '已结算金额', 'paid_amount', 'paid', 'received'],
    balance: ['未收金额', '未付金额', '未收余额', '未付余额', '应收余额', '应付余额',
      '未结金额', '余额', '未收', '未付', 'outstanding', 'balance'],
    salesperson: ['业务员', '销售员', '采购员', '经办人', '负责人', '客户经理',
      'salesperson', 'salesman', 'buyer', 'owner'],
    remark: ['备注', '说明', '摘要', '备注说明', 'remark', 'note', 'memo']
  };

  var TEMPLATE_HEADERS = {
    receivable: ['客户编码', '客户名称', '单据编号', '单据日期', '到期日',
      '应收金额', '已收金额', '未收金额', '业务员', '备注'],
    payable: ['供应商编码', '供应商名称', '单据编号', '单据日期', '到期日',
      '应付金额', '已付金额', '未付金额', '采购员', '备注']
  };

  var SUMMARY_ROW_NAMES = ['合计', '总计', '小计', '累计', 'total', 'subtotal'];

  function isBlank(value) {
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') return !value.replace(/　/g, ' ').trim();
    return false;
  }

  function toText(value) {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) {
      if (isNaN(value.getTime())) return '';
      return value.getFullYear() + '-' + pad(value.getMonth() + 1) + '-' + pad(value.getDate());
    }
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (typeof value === 'number') {
      if (Number.isInteger(value)) return String(value);
      return String(value).replace(/0+$/, '').replace(/\.$/, '');
    }
    var text = String(value).replace(/﻿/g, '').trim();
    if (/^-?\d+\.0$/.test(text)) text = text.slice(0, -2);
    return text;
  }

  function toFloat(value) {
    if (value === null || value === undefined || typeof value === 'boolean') return null;
    if (typeof value === 'number') return round2(value);
    var text = String(value).replace(/﻿/g, '').replace(/　/g, ' ').trim();
    if (!text) return null;
    var negative = false;
    if (text.charAt(0) === '(' && text.charAt(text.length - 1) === ')') {
      negative = true;
      text = text.slice(1, -1);
    } else if (text.charAt(0) === '（' && text.charAt(text.length - 1) === '）') {
      negative = true;
      text = text.slice(1, -1);
    }
    if (text.charAt(0) === '-' && text.charAt(text.length - 1) === '-') {
      text = text.replace(/^-+|-+$/g, '').trim();
    }
    text = text.replace(/\s+/g, '');
    [',', '，', '¥', '￥', '$', '€', '£', '元', 'RMB', 'rmb', 'CNY', 'cny'].forEach(function (token) {
      text = text.split(token).join('');
    });
    if (text.charAt(text.length - 1) === '-' && text.length > 1) {
      negative = true;
      text = text.slice(0, -1);
    }
    if (text.charAt(text.length - 1) === '%') return null;
    if (!text || ['-', '--', '—', '/'].indexOf(text) !== -1) return null;
    var number = Number(text);
    if (!isFinite(number)) return null;
    return round2(negative ? -number : number);
  }

  function toInt(value) {
    if (value === null || value === undefined || typeof value === 'boolean') return null;
    if (typeof value === 'number') return Math.trunc(value);
    var text = String(value).trim();
    if (!text) return null;
    var match = text.match(/-?\d+/);
    return match ? parseInt(match[0], 10) : null;
  }

  function pad(value) {
    return String(value).padStart(2, '0');
  }

  function round2(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  }

  function buildDate(year, month, day) {
    var y = parseInt(year, 10);
    var m = parseInt(month, 10);
    var d = parseInt(day, 10);
    var date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
    if (y < 1990 || y > 2100) return null;
    return date;
  }

  function serialToDate(serial) {
    var number = Number(serial);
    if (!isFinite(number) || number < 1 || number > 100000) return null;
    var date = new Date(Date.UTC(1899, 11, 30) + Math.trunc(number) * 86400000);
    return isNaN(date.getTime()) ? null : date;
  }

  function toDate(value) {
    if (value === null || value === undefined || typeof value === 'boolean') return null;
    if (value instanceof Date) {
      if (isNaN(value.getTime())) return null;
      return buildDate(value.getFullYear(), value.getMonth() + 1, value.getDate());
    }
    if (typeof value === 'number') return serialToDate(value);
    var text = String(value).replace(/﻿/g, '').replace(/　/g, ' ').trim();
    if (!text) return null;
    text = text.split(/[ T]/)[0].trim().replace(/日/g, '');
    var m = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (m) return buildDate(m[1], m[2], m[3]);
    m = text.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?$/);
    if (m) return buildDate(m[1], m[2], m[3]);
    m = text.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m) return buildDate(m[1], m[2], m[3]);
    var normalized = text.replace(/年/g, '-').replace(/月/g, '-');
    m = normalized.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (m) return buildDate(m[1], m[2], m[3]);
    if (/^\d{5}(\.\d+)?$/.test(text)) return serialToDate(parseFloat(text));
    return null;
  }

  function ymd(date) {
    if (!date) return '';
    return date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate());
  }

  function dayDiff(later, earlier) {
    if (!later || !earlier) return 0;
    return Math.round((later.getTime() - earlier.getTime()) / 86400000);
  }

  function addDays(date, days) {
    if (!date) return null;
    return new Date(date.getTime() + days * 86400000);
  }

  function normalizeHeader(value) {
    if (value === null || value === undefined) return '';
    var text = toText(value).replace(/﻿/g, '').toLowerCase();
    text = text.replace(/　/g, ' ');
    text = text.replace(/（/g, '(').replace(/）/g, ')');
    text = text.replace(/：/g, ':').replace(/　/g, ' ');
    text = text.replace(/\*/g, '');
    return text.replace(/\s+/g, '');
  }

  var EXACT_ALIASES = {};
  var FUZZY_ALIASES = [];
  Object.keys(HEADER_SYNONYMS).forEach(function (field) {
    HEADER_SYNONYMS[field].forEach(function (alias) {
      var normalized = normalizeHeader(alias);
      if (!normalized) return;
      if (!(normalized in EXACT_ALIASES)) EXACT_ALIASES[normalized] = field;
      FUZZY_ALIASES.push([normalized, field]);
    });
  });
  FUZZY_ALIASES.sort(function (a, b) { return b[0].length - a[0].length; });

  function matchField(headerValue) {
    var key = normalizeHeader(headerValue);
    if (!key) return null;
    if (EXACT_ALIASES[key]) return EXACT_ALIASES[key];
    for (var i = 0; i < FUZZY_ALIASES.length; i += 1) {
      if (key.indexOf(FUZZY_ALIASES[i][0]) !== -1) return FUZZY_ALIASES[i][1];
    }
    return null;
  }

  function mapHeaderRow(cells) {
    var mapping = {};
    (cells || []).forEach(function (cell, index) {
      if (isBlank(cell)) return;
      var field = matchField(cell);
      if (field && !(field in mapping)) mapping[field] = index;
    });
    return mapping;
  }

  function detectHeaderRow(rows, maxScan) {
    maxScan = maxScan || MAX_HEADER_SCAN;
    var bestIndex = null;
    var bestMapping = {};
    var bestScore = -1;
    var limit = Math.min(rows.length, maxScan);
    for (var i = 0; i < limit; i += 1) {
      var cells = rows[i] || [];
      if (!cells.some(function (cell) { return !isBlank(cell); })) continue;
      var mapping = mapHeaderRow(cells);
      var fields = Object.keys(mapping);
      if (fields.indexOf('partner_name') === -1) continue;
      var hasAmount = fields.indexOf('amount') !== -1 || fields.indexOf('balance') !== -1;
      var hasDate = fields.indexOf('due_date') !== -1 || fields.indexOf('doc_date') !== -1;
      if (!hasAmount && !hasDate) continue;
      var score = fields.length;
      score += fields.indexOf('partner_name') !== -1 ? 3 : 0;
      score += hasAmount ? 2 : 0;
      score += hasDate ? 2 : 0;
      score += fields.indexOf('partner_ref') !== -1 ? 1 : 0;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
        bestMapping = mapping;
      }
    }
    return bestIndex === null ? null : { index: bestIndex, mapping: bestMapping };
  }

  function cell(row, index) {
    if (index === undefined || index === null || index < 0) return null;
    if (!row || index >= row.length) return null;
    return row[index];
  }

  function isSummaryRow(row, mapping) {
    var name = toText(cell(row, mapping.partner_name));
    if (name && SUMMARY_ROW_NAMES.indexOf(normalizeHeader(name)) !== -1) return true;
    if (!name) {
      for (var i = 0; i < (row || []).length; i += 1) {
        var textValue = toText(row[i]);
        if (textValue && SUMMARY_ROW_NAMES.indexOf(normalizeHeader(textValue)) !== -1) return true;
      }
    }
    return false;
  }

  function parseDataRow(row, mapping, rowNumber) {
    var name = toText(cell(row, mapping.partner_name));
    if (!name) throw new Error('往来单位名称为空');
    if (isSummaryRow(row, mapping)) throw new Error('__summary__');

    var partnerRef = toText(cell(row, mapping.partner_ref));
    var docNo = toText(cell(row, mapping.doc_no));
    var salesperson = toText(cell(row, mapping.salesperson));
    var remark = toText(cell(row, mapping.remark));

    var docDate = toDate(cell(row, mapping.doc_date));
    var dueDate = toDate(cell(row, mapping.due_date));
    var termDays = toInt(cell(row, mapping.term_days));
    if (termDays !== null && termDays < 0) termDays = null;

    var amount = toFloat(cell(row, mapping.amount));
    var paidAmount = toFloat(cell(row, mapping.paid_amount));
    var balance = toFloat(cell(row, mapping.balance));

    if (balance === null) {
      if (amount === null && paidAmount === null) {
        throw new Error('金额与余额均为空或无法识别');
      }
      balance = (amount || 0) - (paidAmount || 0);
    }
    amount = round2(amount || 0);
    paidAmount = round2(paidAmount || 0);
    balance = round2(balance);

    var effectiveTerm = termDays === null ? DEFAULT_TERM_DAYS : termDays;
    if (dueDate === null) {
      if (docDate === null) throw new Error('到期日与单据日期均为空或无法识别');
      dueDate = addDays(docDate, effectiveTerm);
    }
    if (docDate === null) docDate = addDays(dueDate, -effectiveTerm);

    return {
      row_no: rowNumber,
      partner_name: name,
      partner_ref: partnerRef,
      doc_no: docNo,
      doc_date: docDate,
      due_date: dueDate,
      term_days: termDays,
      amount: amount,
      paid_amount: paidAmount,
      balance: balance,
      salesperson: salesperson,
      remark: remark
    };
  }

  function parseMatrix(matrix, options) {
    options = options || {};
    var skipZeroBalance = options.skipZeroBalance !== false;
    var autoDetect = options.autoDetectHeader !== false;
    var maxScan = options.maxHeaderScan || MAX_HEADER_SCAN;
    var headerRow = options.headerRow || 1;

    if (!matrix || !matrix.length) throw new Error('文件内容为空，未找到任何数据行');
    var detected = autoDetect ? detectHeaderRow(matrix, maxScan) : null;
    var headerIndex;
    var mapping;
    if (detected) {
      headerIndex = detected.index;
      mapping = detected.mapping;
    } else {
      headerIndex = Math.max(0, (parseInt(headerRow, 10) || 1) - 1);
      if (headerIndex >= matrix.length) {
        throw new Error('指定的表头行（第 ' + (headerIndex + 1) + ' 行）超出文件范围：文件共 ' +
          matrix.length + ' 行');
      }
      mapping = mapHeaderRow(matrix[headerIndex]);
    }

    var headers = (matrix[headerIndex] || []).map(toText);
    var fields = Object.keys(mapping);
    var missing = [];
    if (fields.indexOf('partner_name') === -1) {
      missing.push('往来单位名称类（如：客户名称 / 供应商名称 / 往来单位）');
    }
    if (fields.indexOf('due_date') === -1 && fields.indexOf('doc_date') === -1) {
      missing.push('日期类（到期日 或 单据日期）');
    }
    if (missing.length) {
      var detail = '未识别到必需列：' + missing.join('；') + '。';
      var recognized = Object.keys(mapping).map(function (name) {
        return headers[mapping[name]] + '→' + name;
      });
      if (recognized.length) detail += '已识别列：' + recognized.join('，') + '。';
      var actual = headers.filter(Boolean);
      if (actual.length) detail += '第 ' + (headerIndex + 1) + ' 行实际表头：' + actual.join(' | ') + '。';
      detail += '请检查文件表头，或将「表头所在行」设置为正确的行号。';
      throw new Error(detail);
    }

    var result = {
      rows: [],
      errors: [],
      skipped_empty: 0,
      skipped_zero: 0,
      total_rows: 0,
      header_row: headerIndex + 1,
      header_auto_detected: !!detected,
      headers: headers,
      mapping: mapping,
      sheet_name: options.sheetName || '工作表',
      file_type: options.fileType || ''
    };

    for (var offset = 0; offset < matrix.length - headerIndex - 1; offset += 1) {
      var row = matrix[headerIndex + 1 + offset] || [];
      var rowNumber = headerIndex + 2 + offset;
      if (!row.some(function (item) { return !isBlank(item); })) {
        result.skipped_empty += 1;
        continue;
      }
      if (isSummaryRow(row, mapping)) {
        result.skipped_empty += 1;
        continue;
      }
      result.total_rows += 1;
      try {
        var parsed = parseDataRow(row, mapping, rowNumber);
        if (skipZeroBalance && parsed.balance <= 0) {
          result.skipped_zero += 1;
          continue;
        }
        result.rows.push(parsed);
      } catch (error) {
        if (error.message === '__summary__') {
          result.skipped_empty += 1;
          result.total_rows -= 1;
          continue;
        }
        result.errors.push({ row_no: rowNumber, message: error.message });
      }
    }

    if (!result.rows.length) {
      var message = '未能导入任何有效数据（数据 ' + result.total_rows + ' 行，错误 ' +
        result.errors.length + ' 行，跳过 ' +
        (result.skipped_empty + result.skipped_zero) + ' 行）。';
      if (result.errors.length) {
        message += '\n' + result.errors.slice(0, 5).map(function (item) {
          return '第 ' + item.row_no + ' 行：' + item.message;
        }).join('\n');
      }
      throw new Error(message);
    }
    return result;
  }

  function computeAging(reportDate, docDate, dueDate, balance, highRiskAmount) {
    reportDate = reportDate instanceof Date ? reportDate : toDate(reportDate);
    docDate = docDate instanceof Date ? docDate : toDate(docDate);
    dueDate = dueDate instanceof Date ? dueDate : toDate(dueDate);
    var ageDays = docDate ? dayDiff(reportDate, docDate) : 0;
    var daysOverdue = dueDate ? dayDiff(reportDate, dueDate) : 0;
    var bucket;
    if (daysOverdue <= 0) bucket = 'not_due';
    else if (daysOverdue <= 30) bucket = 'd0_30';
    else if (daysOverdue <= 60) bucket = 'd30_60';
    else if (daysOverdue <= 90) bucket = 'd60_90';
    else bucket = 'd90_plus';

    var isOverdue = daysOverdue > 0;
    var threshold = Number(highRiskAmount || DEFAULT_HIGH_RISK_AMOUNT);
    var value = Number(balance || 0);
    var riskLevel;
    if (!isOverdue || value <= 0) riskLevel = 'normal';
    else if (value >= threshold) riskLevel = 'high';
    else if (daysOverdue > 90 || value >= threshold * 0.5) riskLevel = 'watch';
    else riskLevel = 'normal';

    return {
      age_days: ageDays,
      days_overdue: daysOverdue,
      bucket: bucket,
      is_overdue: isOverdue,
      risk_level: riskLevel
    };
  }

  function analyze(lines, reportDate, highRiskAmount) {
    var report = reportDate instanceof Date ? reportDate : toDate(reportDate);
    if (!report) throw new Error('账龄截止日无效');
    var buckets = {};
    BUCKETS.forEach(function (bucket) {
      buckets[bucket.key] = { count: 0, balance: 0 };
    });
    var totals = {
      count: lines.length,
      balance: 0,
      overdue_balance: 0,
      high_amount: 0,
      high_count: 0,
      watch_count: 0,
      normal_count: 0,
      bucket_counts: {},
      bucket_balances: {}
    };
    var annotated = lines.map(function (line) {
      var aging = computeAging(report, line.doc_date, line.due_date, line.balance, highRiskAmount);
      var merged = Object.assign({}, line, aging);
      totals.balance = round2(totals.balance + Number(line.balance || 0));
      if (aging.is_overdue) totals.overdue_balance = round2(totals.overdue_balance + Number(line.balance || 0));
      if (aging.risk_level === 'high') {
        totals.high_count += 1;
        totals.high_amount = round2(totals.high_amount + Number(line.balance || 0));
      } else if (aging.risk_level === 'watch') {
        totals.watch_count += 1;
      } else {
        totals.normal_count += 1;
      }
      var bucket = buckets[aging.bucket];
      bucket.count += 1;
      bucket.balance = round2(bucket.balance + Number(line.balance || 0));
      return merged;
    });
    BUCKETS.forEach(function (bucket) {
      totals.bucket_counts[bucket.key] = buckets[bucket.key].count;
      totals.bucket_balances[bucket.key] = buckets[bucket.key].balance;
    });
    totals.overdue_rate = totals.balance > 0
      ? round2(totals.overdue_balance / totals.balance * 100) : 0;
    return { lines: annotated, totals: totals, buckets: buckets };
  }

  root.AgingEngine = {
    DEFAULT_TERM_DAYS: DEFAULT_TERM_DAYS,
    DEFAULT_HIGH_RISK_AMOUNT: DEFAULT_HIGH_RISK_AMOUNT,
    BUCKETS: BUCKETS,
    BUCKET_LABELS: BUCKET_LABELS,
    RISK_LEVELS: RISK_LEVELS,
    RISK_LABELS: RISK_LABELS,
    HEADER_SYNONYMS: HEADER_SYNONYMS,
    TEMPLATE_HEADERS: TEMPLATE_HEADERS,
    normalizeHeader: normalizeHeader,
    mapHeaderRow: mapHeaderRow,
    detectHeaderRow: detectHeaderRow,
    parseMatrix: parseMatrix,
    computeAging: computeAging,
    analyze: analyze,
    toText: toText,
    toFloat: toFloat,
    toDate: toDate,
    ymd: ymd,
    round2: round2
  };
})(typeof window !== 'undefined' ? window : globalThis);
