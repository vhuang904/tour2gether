/**
 * 獨立 Google Apps Script（V8）：貼入 Apps Script 專案後執行 sendDigestTest。
 * 首次執行須授權讀寫試算表及寄信；改用 GmailApp 後須重新執行以完成 Gmail 授權。
 * 編輯器直接執行時使用下方測試信箱。
 * language 預設 en（英文），可改成 zh-TW（繁體中文），與 App 語言設定互相獨立。
 * 使用試算表現有雙語欄位，不自動翻譯；英文描述缺漏時使用類別摘要，店名保留原名備援。
 * 僅處理 pending，不會將既有資料自動排入寄送佇列；測試寄送也會標為 sent。
 * 可為 sendDigestTest 建立每週時間觸發條件，但收件人仍只有測試信箱。
 *
 * GmailApp 成功表示服務已接受寄送，不保證到達收件匣。
 * 寄信與試算表寫入不是同一筆交易：若寄信後回寫失敗，須先核對收件結果、
 * 手動修復日誌所列狀態再重跑，否則可能重寄。執行期間請勿排序或編輯來源列；
 * ScriptLock 只防止同一 Apps Script 專案內的併發執行。
 */
const EMAIL_DIGEST_CONFIG = {
  spreadsheetId: '1sQELyvgQ8ZhL0iolKZ0fdEgr6z7FrFsK5Cgl2xz145g',
  testEmail: 'vhuang904@gmail.com',
  language: 'en',
  sections: [
    { sheetName: 'Auto_Discovered' },
    { sheetName: 'Island_Discovered' },
    { sheetName: 'Attractions' },
    { sheetName: 'Medical' }
  ],
  maxBodyBytes: 180 * 1024
};

const EMAIL_DIGEST_I18N = {
  en: {
    subject: "BigV's Nest Weekly: Discover This Week's New Spots!",
    senderName: "BigV's Nest",
    title: "BigV's Nest Weekly",
    subtitle: "Discover this week's new spots!",
    intro: 'Fresh discoveries, from dining and island escapes to care for your travels.',
    plainTextFallback: "BigV's Nest Weekly: Discover this week's new spots. Use an HTML-capable email client to view the full digest with photos.",
    sections: {
      Auto_Discovered: 'Metro Dining',
      Island_Discovered: 'Island Escapes',
      Attractions: 'Leisure & Landmarks',
      Medical: 'Healthcare'
    },
    cities: {
      manila: 'Manila', cebu: 'Cebu', davao: 'Davao', boracay: 'Boracay',
      palawan: 'Palawan', bohol: 'Bohol', siargao: 'Siargao', samal: 'Samal'
    },
    rating: 'Rating: ',
    noRating: 'Not yet rated',
    review: 'review',
    reviews: 'reviews',
    newItem: 'new spot',
    newItems: 'new spots',
    directions: 'Get Directions',
    footer: 'This is a test digest for the specified recipient. Check with each place and its map listing for current hours, services and ratings.'
  },
  'zh-TW': {
    subject: '大V的旅遊窩週報：本週新進探索熱點推薦！',
    senderName: '大V的旅遊窩',
    title: '大V的旅遊窩週報',
    subtitle: '本週新進探索熱點推薦！',
    intro: '本週新進探索熱點推薦，從美食、秘境到旅途中的安心守護。',
    plainTextFallback: '大V的旅遊窩週報：本週有新進探索熱點推薦，請使用支援 HTML 的郵件客戶端檢視完整圖文內容。',
    sections: {
      Auto_Discovered: '都會美食',
      Island_Discovered: '海島秘境',
      Attractions: '休閒熱點',
      Medical: '醫療守護'
    },
    cities: {
      manila: '馬尼拉', cebu: '宿霧', davao: '達沃', boracay: '長灘島',
      palawan: '巴拉望', bohol: '薄荷島', siargao: '錫亞高島', samal: '薩馬爾島'
    },
    rating: '評分：',
    noRating: '尚無評分',
    review: '則評論',
    reviews: '則評論',
    newItem: '個新項目',
    newItems: '個新項目',
    directions: '查看地圖導航',
    footer: '這是寄給指定收件人的測試週報。營業時間、服務與評分請以店家及地圖最新資訊為準。'
  }
};

function getDigestLanguage_() {
  const language = EMAIL_DIGEST_CONFIG.language;
  if (language !== 'en' && language !== 'zh-TW') {
    throw new Error('EMAIL_DIGEST_CONFIG.language 必須是 en 或 zh-TW，已停止寄送。');
  }
  return language;
}

/**
 * 回傳以欄位名稱為 key、1 起算欄號為值的對照表，不依賴欄位順序。
 * 相容 17 欄既有表頭；notify_status 在標準表後成為第 18 欄，
 * 若已有擴充欄則追加至實際最後一欄，不覆蓋任何現有欄位。
 */
function getColumnMapping(sheet) {
  const lastColumn = sheet.getLastColumn();
  if (!lastColumn) throw new Error(sheet.getName() + ' 缺少表頭，已停止寄送。');

  const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  const mapping = Object.create(null);
  headers.forEach(function(header, index) {
    const key = normalizeDigestHeader_(header);
    if (!key) return;
    if (mapping[key]) throw new Error(sheet.getName() + ' 有重複表頭：' + header);
    mapping[key] = index + 1;
  });

  const required = [
    'name_zh', 'name_en', 'category', 'city', 'google_rating',
    'review_count', 'image_url', 'nav_link', 'is_active'
  ];
  required.forEach(function(key) {
    if (!mapping[normalizeDigestHeader_(key)]) {
      throw new Error(sheet.getName() + ' 缺少必要欄位：' + key);
    }
  });

  if (!mapping.notifystatus) {
    const nextColumn = lastColumn + 1;
    if (nextColumn > sheet.getMaxColumns()) sheet.insertColumnAfter(lastColumn);
    sheet.getRange(1, nextColumn).setValue('notify_status');
    mapping.notifystatus = nextColumn;
    Logger.log(sheet.getName() + ' 已在第 ' + nextColumn + ' 欄追加 notify_status。');
  }

  // 對外保留標準欄名，並接受現有前端支援的大小寫、空格、底線、連字號差異。
  required.concat(['description', 'description_en', 'notify_status']).forEach(function(key) {
    mapping[key] = mapping[normalizeDigestHeader_(key)];
  });
  return mapping;
}

function normalizeDigestHeader_(value) {
  return String(value).trim().replace(/^['"]|['"]$/g, '')
    .toLowerCase().replace(/[\s_-]/g, '');
}

function digestText_(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

/**
 * 手動呼叫可指定單一信箱；無參數或時間觸發器事件則使用設定中的測試信箱。
 */
function sendDigestTest(testEmail) {
  const language = getDigestLanguage_();
  const text = EMAIL_DIGEST_I18N[language];
  if (testEmail === undefined ||
      (testEmail && typeof testEmail === 'object' && testEmail.triggerUid)) {
    testEmail = EMAIL_DIGEST_CONFIG.testEmail;
  }
  if (typeof testEmail !== 'string' ||
      !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(testEmail.trim())) {
    throw new Error('請提供一個有效的測試信箱，不接受多位收件人。');
  }
  testEmail = testEmail.trim();

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('另一個週報任務仍在執行，請稍後再試。');

  let accepted = false;
  let groups = [];
  try {
    const spreadsheet = SpreadsheetApp.openById(EMAIL_DIGEST_CONFIG.spreadsheetId);
    const sources = EMAIL_DIGEST_CONFIG.sections.map(function(section) {
      const sheet = spreadsheet.getSheetByName(section.sheetName);
      if (!sheet) throw new Error('找不到必要分頁：' + section.sheetName);
      return { sheet: sheet, title: text.sections[section.sheetName] };
    });
    groups = sources.map(collectDigestGroup_).filter(function(group) {
      return group.items.length > 0;
    });
    SpreadsheetApp.flush();

    if (!groups.length) {
      Logger.log('目前無待通知新項目');
      return;
    }
    const total = groups.reduce(function(sum, group) { return sum + group.items.length; }, 0);
    const message = buildDigestMessage_(groups);
    const plainTextFallback = text.plainTextFallback;
    const bodyBytes = Utilities.newBlob(message.htmlBody + plainTextFallback).getBytes().length;
    if (bodyBytes > EMAIL_DIGEST_CONFIG.maxBodyBytes) {
      throw new Error('週報內容過大（' + bodyBytes + ' bytes），未寄送。請縮小 pending 批次後重試。');
    }
    if (MailApp.getRemainingDailyQuota() < 1) {
      throw new Error('今日 MailApp 收件人配額不足，未寄送且保留 pending。');
    }
    groups.forEach(assertDigestSnapshot_);
    Logger.log('準備寄出 ' + total + ' 個項目：' + digestRowManifest_(groups));
    GmailApp.sendEmail(testEmail, text.subject, plainTextFallback, {
      htmlBody: message.htmlBody,
      name: text.senderName,
      from: 'service@tour2gether.ph'
    });
    accepted = true;

    groups.forEach(function(group) {
      assertDigestSnapshot_(group);
      const cells = group.items.map(function(item) {
        return group.sheet.getRange(item.rowNumber, group.mapping.notify_status).getA1Notation();
      });
      group.sheet.getRangeList(cells).setValue('sent');
      SpreadsheetApp.flush();
      Logger.log(group.sheet.getName() + ' 已標記完成：' + group.items.length + ' 個項目 → sent。');
    });
    Logger.log('週報已交付寄信服務，全部 ' + total + ' 個項目已標記完成。');
    return { recipient: testEmail, sentCount: total };
  } catch (error) {
    Logger.log((accepted
      ? '警告：信件已交付，但 sent 回寫未全部完成；請勿直接重跑。請核對以下來源列：' +
        digestRowManifest_(groups) + '。錯誤：'
      : '週報未完成寄送，未標記 sent。錯誤：') + error.message);
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function collectDigestGroup_(source) {
  const language = getDigestLanguage_();
  const text = EMAIL_DIGEST_I18N[language];
  const sheet = source.sheet;
  const mapping = getColumnMapping(sheet);
  const width = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, width).getDisplayValues()[0];
  const rows = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues() : [];
  const items = [];
  rows.forEach(function(row, index) {
    const field = function(key) { return mapping[key] ? digestText_(row[mapping[key] - 1]) : ''; };
    const active = field('is_active').replace(/['"]/g, '').trim().toUpperCase();
    if (field('notify_status') !== 'pending' || active === 'FALSE') return;

    const nameZh = field('name_zh');
    const nameEn = field('name_en');
    // 郵件不顯示類別開頭的國旗；保留試算表原值及其餘文字。
    const rawCategory = field('category').replace(/^(?:[\u{1F1E6}-\u{1F1FF}]{2}\s*)+/u, '').trim();
    const category = translateDigestCategory_(rawCategory, language, source.title);
    const description = language === 'en'
      ? field('description_en') || category
      : field('description') || field('description_en') || category;
    const navLink = digestHttpsUrl_(field('nav_link'));
    if (!(nameZh || nameEn) || !navLink) {
      throw new Error(sheet.getName() + ' 第 ' + (index + 2) + ' 列缺少店名或有效 HTTPS nav_link。');
    }
    const imageUrl = field('image_url').split(',').map(function(url) {
      return digestHttpsUrl_(url.trim());
    }).find(function(url) {
      return url && !/^https:\/\/(?:goo\.gl|maps\.app\.goo\.gl)(?:[/?#]|$)/i.test(url);
    }) || '';
    if (!imageUrl) Logger.log(sheet.getName() + ' 第 ' + (index + 2) + ' 列無有效封面圖，將顯示文字卡片。');
    items.push({
      rowNumber: index + 2,
      snapshot: JSON.stringify(row),
      nameZh: nameZh,
      nameEn: nameEn,
      name: language === 'en' ? nameEn || nameZh : nameZh || nameEn,
      category: category,
      city: text.cities[field('city').toLowerCase()] || field('city'),
      rating: field('google_rating'),
      reviewCount: field('review_count'),
      imageUrl: imageUrl,
      description: description,
      navLink: navLink
    });
  });
  return { sheet: sheet, mapping: mapping, width: width, headers: headers, title: source.title, items: items };
}

// 獨立腳本沿用 App 的類別用語，不載入前端模組或改寫試算表。
function translateDigestCategory_(category, language, sectionTitle) {
  if (!category || language !== 'en') return category;
  const rules = [
    [/24.*藥局/, '24H Pharmacy'],
    [/藥局/, 'Pharmacy'],
    [/牙科/, 'Dental Clinic'],
    [/醫院/, 'General Hospital'],
    [/診所|醫療/, 'Medical Clinic'],
    [/日料|日式|japanese/i, 'Japanese Cuisine'],
    [/中餐|中式|粵菜|川菜|chinese/i, 'Chinese Cuisine'],
    [/海鮮|seafood|dampa/i, 'Seafood Feast'],
    [/西餐|西洋|牛排|義式|western|steak/i, 'Western Cuisine'],
    [/菲式|菲律賓|filipino/i, 'Filipino Cuisine'],
    [/火鍋|燒肉|燒烤|bbq|hotpot/i, 'BBQ & Hotpot'],
    [/早午餐|咖啡|甜點|brunch|cafe/i, 'Cafe & Brunch'],
    [/夜生活|酒吧|夜店|nightlife|bar/i, 'Nightlife'],
    [/商場|購物|百貨|mall|shopping/i, 'Upscale Malls'],
    [/賭場|casino|博弈/i, 'Casino / Hotels'],
    [/沙灘|海灘|beach/i, 'Beaches'],
    [/跳島|潛水|浮潛|hopping|diving/i, 'Island Hopping'],
    [/生態|秘境|瀑布|nature/i, 'Eco Tours'],
    [/villa|飯店|酒店|hotel|resort/i, 'Hotels & Villas'],
    [/歷史|古蹟|文化|觀光|景點|attraction/i, 'Top Sights'],
    [/美食|餐廳/, 'Dining']
  ];
  for (const rule of rules) {
    if (rule[0].test(category)) return rule[1];
  }
  if (/[\u3400-\u9fff]/u.test(category)) {
    Logger.log('類別尚無英文對照，郵件改用分區名稱：' + category);
    return sectionTitle;
  }
  return category;
}

// 避免寄送期間有人排序或更改資料，卻把不同項目誤標為 sent。
function assertDigestSnapshot_(group) {
  const headers = group.sheet.getRange(1, 1, 1, group.width).getDisplayValues()[0];
  if (JSON.stringify(headers) !== JSON.stringify(group.headers)) {
    throw new Error(group.sheet.getName() + ' 表頭在執行期間變更。');
  }
  const lastRow = group.items[group.items.length - 1].rowNumber;
  const rows = group.sheet.getRange(2, 1, lastRow - 1, group.width).getValues();
  group.items.forEach(function(item) {
    if (JSON.stringify(rows[item.rowNumber - 2]) !== item.snapshot) {
      throw new Error(group.sheet.getName() + ' 第 ' + item.rowNumber + ' 列在執行期間變更。');
    }
  });
}

function digestRowManifest_(groups) {
  return groups.map(function(group) {
    return group.sheet.getName() + ' 列 ' + group.items.map(function(item) {
      return item.rowNumber;
    }).join(',');
  }).join('；');
}

function digestHttpsUrl_(value) {
  return /^https:\/\/[a-z0-9.-]+(?::\d+)?(?:[/?#][^\s<>"\\]*)?$/i.test(value) ? value : '';
}

function escapeDigestHtml_(value) {
  return digestText_(value).replace(/[&<>"']/g, function(character) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
  });
}

function digestRatingText_(item) {
  const text = EMAIL_DIGEST_I18N[getDigestLanguage_()];
  const rating = Number(item.rating);
  const count = Number(item.reviewCount.replace(/,/g, ''));
  const stars = item.rating && Number.isFinite(rating) && rating > 0 && rating <= 5
    ? text.rating + rating.toFixed(1) + ' / 5' : text.noRating;
  return stars + (item.reviewCount && Number.isFinite(count) && Number.isInteger(count) && count >= 0
    ? ' | ' + count.toLocaleString('en-US') + ' ' + (count === 1 ? text.review : text.reviews) : '');
}

function buildDigestMessage_(groups) {
  const language = getDigestLanguage_();
  const text = EMAIL_DIGEST_I18N[language];
  const escape = escapeDigestHtml_;
  const plainSections = [];
  const sections = groups.map(function(group) {
    plainSections.push(group.title + '\n' + group.items.map(function(item) {
      return [item.name, language === 'zh-TW' && item.nameEn && item.nameEn !== item.name ? item.nameEn : '',
        [item.city, item.category].filter(Boolean).join(' / '), digestRatingText_(item),
        item.description, text.directions + ': ' + item.navLink].filter(Boolean).join('\n');
    }).join('\n\n'));
    const cards = group.items.map(function(item) {
      const description = Array.from(item.description || '');
      const excerpt = description.length > 240 ? description.slice(0, 240).join('') + '...' : description.join('');
      return '<tr><td style="padding:0 0 20px;">' +
        '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#0f172a" ' +
        'style="width:100%;table-layout:fixed;background:#0f172a;border:1px solid #334155;border-radius:16px;">' +
        (item.imageUrl ? '<tr><td><img src="' + escape(item.imageUrl) + '" alt="' +
          escape(item.name) + '" width="550" ' +
          'style="display:block;width:100%;max-width:550px;height:auto;border:0;border-radius:16px 16px 0 0;"></td></tr>' : '') +
        '<tr><td style="padding:22px;overflow-wrap:anywhere;word-break:break-word;">' +
        '<p style="margin:0 0 8px;color:#cbd5e1;font-size:12px;">' +
          escape([item.city, item.category].filter(Boolean).join(' / ')) + '</p>' +
        '<h3 style="margin:0;color:#f8fafc;font-size:21px;line-height:1.4;">' + escape(item.name) + '</h3>' +
        (language === 'zh-TW' && item.nameEn && item.nameEn !== item.name ? '<p style="margin:6px 0 0;color:#cbd5e1;font-size:14px;">' + escape(item.nameEn) + '</p>' : '') +
        '<p style="margin:14px 0;color:#fbbf24;font-size:14px;">' + escape(digestRatingText_(item)) + '</p>' +
        (excerpt ? '<p style="margin:0 0 20px;color:#e2e8f0;font-size:15px;line-height:1.8;">' + escape(excerpt) + '</p>' : '') +
        '<table role="presentation" cellspacing="0" cellpadding="0"><tr><td bgcolor="#fbbf24" style="border-radius:8px;">' +
        '<a href="' + escape(item.navLink) + '" style="display:inline-block;padding:13px 20px;' +
        'color:#020617;background:#fbbf24;border-radius:8px;text-decoration:none;font-size:14px;font-weight:bold;">' +
        escape(text.directions) + '</a></td></tr></table></td></tr></table></td></tr>';
    }).join('');
    return '<tr><td style="padding:24px 0 14px;"><h2 style="margin:0;color:#fde68a;font-size:20px;">' +
      escape(group.title) + ' <span style="color:#cbd5e1;font-size:13px;">/ ' + group.items.length +
      ' ' + escape(group.items.length === 1 ? text.newItem : text.newItems) + '</span></h2></td></tr>' + cards;
  }).join('');

  return {
    body: text.title + '\n' + text.subtitle + '\n\n' + plainSections.join('\n\n----------\n\n') +
      '\n\n' + text.footer,
    htmlBody: '<!doctype html><html lang="' + (language === 'en' ? 'en' : 'zh-Hant') + '"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<meta name="color-scheme" content="dark"><title>' + escape(text.title) + '</title></head>' +
      '<body style="margin:0;padding:0;background:#020617;color:#f8fafc;font-family:Arial,Helvetica,sans-serif;">' +
      '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#020617">' +
      '<tr><td align="center" style="padding:24px 12px;">' +
      '<!--[if mso]><table role="presentation" width="600"><tr><td><![endif]-->' +
      '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;table-layout:fixed;">' +
      '<tr><td style="padding:24px;color:#f8fafc;border-bottom:1px solid #334155;">' +
      '<p style="margin:0 0 12px;font-size:12px;letter-spacing:3px;color:#fbbf24;">BIG V - WEEKLY DIGEST</p>' +
      '<h1 style="margin:0;font-size:28px;line-height:1.4;">' + escape(text.title) + '</h1>' +
      '<p style="margin:12px 0 0;color:#cbd5e1;font-size:15px;line-height:1.7;">' + escape(text.intro) + '</p>' +
      '</td></tr><tr><td style="padding:0 24px;">' +
      '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="table-layout:fixed;">' + sections +
      '</table></td></tr><tr><td style="padding:24px;color:#cbd5e1;font-size:12px;line-height:1.8;border-top:1px solid #334155;">' +
      escape(text.footer) +
      '</td></tr></table><!--[if mso]></td></tr></table><![endif]--></td></tr></table></body></html>'
  };
}
