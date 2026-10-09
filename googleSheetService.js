/**
 * Tour2gether PWA - Google Sheets CMS 資料串接服務 (v40.0 雙語摘要與 place_id 完整對齊版)
 * 1. 支援 place_id 唯一識別，保障 BigV 特約與自然收錄無縫去重覆蓋
 * 2. 完整映射 description (繁中) 與 description_en (原生英文)
 * 3. 延續 RFC 4180 強固 CSV 解析與嚴密 is_active 過濾機制
 * 4. 具備多層級 HTTP 防快取標頭，確保即時反映雲端異動
 */

export const SHEET_CONFIG = {
  spreadsheetId: "1sQELyvgQ8ZhL0iolKZ0fdEgr6z7FrFsK5Cgl2xz145g",
  sheets: {
    bigVPicks: "BigV_Picks",
    attractions: "Attractions",
    promotions: "Promotions",
    autoDiscovered: "Auto_Discovered",
    medical: "Medical",
    islandDiscovered: "Island_Discovered"
  }
};

/**
 * RFC 4180 強固型 CSV 狀態機解析器
 */
export function parseCSV(text) {
  const rows = [];
  let currentRow = [];
  let currentVal = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          currentVal += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        currentVal += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        currentRow.push(currentVal.trim());
        currentVal = '';
      } else if (char === '\r') {
        if (nextChar === '\n') i++;
        currentRow.push(currentVal.trim());
        rows.push(currentRow);
        currentRow = [];
        currentVal = '';
      } else if (char === '\n') {
        currentRow.push(currentVal.trim());
        rows.push(currentRow);
        currentRow = [];
        currentVal = '';
      } else {
        currentVal += char;
      }
    }
  }

  if (currentVal || currentRow.length > 0) {
    currentRow.push(currentVal.trim());
    rows.push(currentRow);
  }

  return rows;
}

/**
 * 抓取試算表 CSV（極致無快取模式，保證每一次都是雲端最新資料）
 */
export async function fetchSheetCsv(sheetName) {
  const timestamp = Date.now();
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_CONFIG.spreadsheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}&_t=${timestamp}`;
  
  const response = await fetch(url, {
    method: 'GET',
    cache: 'no-store',
    headers: {
      'Pragma': 'no-cache',
      'Cache-Control': 'no-cache, no-store, max-age=0, must-revalidate'
    }
  });
  
  if (!response.ok) {
    console.error(`[Sheet 抓取失敗] 分頁: ${sheetName}, HTTP 狀態: ${response.status}`);
    throw new Error(`無法抓取分頁 ${sheetName}: HTTP ${response.status}`);
  }

  const csvText = await response.text();
  const rawRows = parseCSV(csvText);
  if (!rawRows || rawRows.length < 2) {
    console.warn(`[Sheet 資料為空] 分頁: ${sheetName} 沒有有效列`);
    return [];
  }

  // 將表頭轉為乾淨的小寫 key
  const headers = rawRows[0].map(h => h.toLowerCase().trim().replace(/^['"]|['"]$/g, '').replace(/[\s_-]/g, ''));
  const records = [];

  for (let r = 1; r < rawRows.length; r++) {
    const row = rawRows[r];
    if (!row || row.length === 0 || !row[0]) continue;

    const obj = {};
    headers.forEach((key, colIndex) => {
      let val = row[colIndex] !== undefined ? row[colIndex] : '';
      if (typeof val === 'string') {
        val = val.trim();
        if (val.startsWith("'") || val.startsWith('"')) {
          val = val.replace(/^['"]/, '').replace(/['"]$/, '');
        }
      }
      obj[key] = val;
    });

    records.push(obj);
  }

  return records;
}

function cleanPhoneNumber(phone) {
  if (!phone) return '';
  let str = String(phone).trim();
  str = str.replace(/^['"]+/, '').replace(/['"]+$/, '');
  return str;
}

function extractImages(row) {
  const raw = row.imageurl || row.image_url || row.image || row.photos || row.photo || '';
  if (!raw || typeof raw !== 'string') return [];
  return raw.split(',')
    .map(s => s.trim())
    .filter(s => s.startsWith('http') && !s.includes('goo.gl/maps') && !s.includes('maps.app.goo.gl'));
}

function extractWebsite(row) {
  const web = row.website || row.web || row.official_website || row.url || '';
  if (typeof web === 'string' && web.trim().startsWith('http')) {
    return web.trim();
  }
  return '';
}

// ⭐ 終極強固過濾器：絕不漏殺任何形態的 FALSE
export function checkIsActive(row) {
  if (!row) return false;

  let rawVal = undefined;

  const candidateKeys = ['isactive', 'is_active', 'active', 'is_enabled', 'enabled'];
  for (let k of candidateKeys) {
    if (row[k] !== undefined && row[k] !== null && row[k] !== '') {
      rawVal = row[k];
      break;
    }
  }

  if (rawVal === undefined) {
    for (let k in row) {
      const cleanKey = k.toLowerCase().replace(/[\s_-]/g, '');
      if (cleanKey === 'isactive' || cleanKey === 'active') {
        rawVal = row[k];
        break;
      }
    }
  }

  if (rawVal === undefined || rawVal === null || String(rawVal).trim() === '') {
    return true;
  }

  if (rawVal === false || rawVal === 'false') return false;
  if (rawVal === true || rawVal === 'true') return true;

  const s = String(rawVal).replace(/['"]/g, '').trim().toUpperCase();
  if (s === 'FALSE' || s === '0' || s === 'OFF' || s === 'NO' || s === 'F') {
    return false;
  }

  return true;
}

function normalizeBigVPicks(rows) {
  return rows
    .filter(checkIsActive)
    .map(row => ({
      id: row.placeid || row.id,
      place_id: row.placeid || row.id || '',
      city: (row.city || '').toLowerCase().trim(),
      name: row.namezh || row.name || row.id,
      name_zh: row.namezh || row.name || '',
      name_en: row.nameen || '',
      name_tl: row.nametl || '',
      category: row.category || '',
      categoryKey: (row.category || '').toLowerCase().trim(),
      big_v_comment: row.bigvcommentzh || row.bigvcomment || '',
      bigv_comment_zh: row.bigvcommentzh || row.bigvcomment || '',
      bigv_comment_en: row.bigvcommenten || '',
      bigv_comment_tl: row.bigvcommenttl || '',
      must_try: row.musttryzh || row.musttry || '',
      must_try_zh: row.musttryzh || row.musttry || '',
      must_try_en: row.musttryen || '',
      must_try_tl: row.musttrytl || '',
      v_score: row.vscore || row.bigvscore || '',
      google_rating: row.googlerating || row.rating || '',
      google_reviews: row.googlereviews || row.reviewcount || row.reviews || '',
      address: row.address || '',
      phone: cleanPhoneNumber(row.phone),
      website: extractWebsite(row),
      image_url: row.imageurl || row.image || '',
      images: extractImages(row),
      nav_link: row.navlink || row.nav_link || '',
      description: row.description || row.desc || row.desczh || '',
      description_en: row.descriptionen || row.descen || '',
      is_active: checkIsActive(row)
    }));
}

function normalizeAttractions(rows) {
  return rows
    .filter(checkIsActive)
    .map(row => ({
      id: row.placeid || row.id,
      place_id: row.placeid || row.id || '',
      city: (row.city || '').toLowerCase().trim(),
      type: (row.type || 'attraction').toLowerCase().trim(),
      name: row.namezh || row.name || row.id,
      name_zh: row.namezh || row.name || '',
      name_en: row.nameen || '',
      name_tl: row.nametl || '',
      category: row.category || '',
      categoryKey: (row.category || '').toLowerCase().trim(),
      desc: row.desczh || row.description || row.desc || '',
      desc_zh: row.desczh || row.description || row.desc || '',
      desc_en: row.descen || '',
      desc_tl: row.desctl || '',
      description: row.description || row.desc || row.desczh || '',
      description_en: row.descriptionen || row.descen || '',
      googleRating: parseFloat(row.googlerating || row.rating) || 4.5,
      googleReviewCount: parseInt(row.googlereviewcount || row.reviewcount || row.reviews, 10) || 100,
      address: row.address || '',
      phone: cleanPhoneNumber(row.phone),
      website: extractWebsite(row),
      image_url: row.imageurl || row.image || '',
      images: extractImages(row),
      nav_link: row.navlink || row.nav_link || '',
      is_active: checkIsActive(row)
    }));
}

function normalizePromotions(rows) {
  return rows
    .filter(checkIsActive)
    .map(row => ({
      id: row.id,
      city: (row.city || 'all').toLowerCase().trim(),
      type: (row.type || 'ongoing').toLowerCase().trim(),
      store_name: row.storename || row.brand || '精選特約門市',
      title: row.titlezh || row.title || '',
      title_zh: row.titlezh || row.title || '',
      title_en: row.titleen || '',
      title_tl: row.titletl || '',
      description: row.descriptionzh || row.description || '',
      description_zh: row.descriptionzh || row.description || '',
      description_en: row.descriptionen || '',
      description_tl: row.descriptiontl || '',
      valid_until: row.validuntil || '長期有效',
      address: row.address || '',
      phone: cleanPhoneNumber(row.phone),
      website: extractWebsite(row),
      image_url: row.imageurl || row.image || '',
      images: extractImages(row),
      nav_link: row.navlink || row.nav_link || '',
      is_active: checkIsActive(row)
    }));
}

function normalizeAutoDiscovered(rows) {
  return rows
    .filter(checkIsActive)
    .map(row => ({
      id: row.placeid || row.id,
      place_id: row.placeid || row.id || '',
      city: (row.city || '').toLowerCase().trim(),
      type: (row.type || 'restaurant').toLowerCase().trim(),
      name_zh: row.namezh || '',
      name_en: row.nameen || '',
      name_tl: row.nametl || '',
      category: row.category || '',
      categoryKey: (row.category || '').toLowerCase().trim(),
      googleRating: parseFloat(row.googlerating || row.rating) || 4.5,
      google_rating: parseFloat(row.googlerating || row.rating) || 4.5,
      googleReviewCount: parseInt(row.reviewcount || row.googlereviewcount || row.reviews, 10) || 50,
      review_count: parseInt(row.reviewcount || row.googlereviewcount || row.reviews, 10) || 50,
      address: row.address || '',
      phone: cleanPhoneNumber(row.phone),
      website: extractWebsite(row),
      image_url: row.imageurl || row.image || '',
      images: extractImages(row),
      nav_link: row.navlink || row.nav_link || '',
      description: row.description || row.desc || row.desczh || '',
      description_en: row.descriptionen || row.descen || '',
      is_active: checkIsActive(row)
    }));
}

function normalizeIslandDiscovered(rows) {
  return rows
    .filter(checkIsActive)
    .map(row => ({
      id: row.placeid || row.id,
      place_id: row.placeid || row.id || '',
      city: (row.city || '').toLowerCase().trim(),
      type: (row.type || 'attraction').toLowerCase().trim(),
      name_zh: row.namezh || '',
      name_en: row.nameen || '',
      name_tl: row.nametl || '',
      category: row.category || '',
      categoryKey: (row.category || '').toLowerCase().trim(),
      googleRating: parseFloat(row.googlerating || row.rating) || 4.5,
      google_rating: parseFloat(row.googlerating || row.rating) || 4.5,
      googleReviewCount: parseInt(row.reviewcount || row.googlereviewcount || row.reviews, 10) || 50,
      review_count: parseInt(row.reviewcount || row.googlereviewcount || row.reviews, 10) || 50,
      address: row.address || '',
      phone: cleanPhoneNumber(row.phone),
      website: extractWebsite(row),
      image_url: row.imageurl || row.image || '',
      images: extractImages(row),
      nav_link: row.navlink || row.nav_link || '',
      description: row.description || row.desc || row.desczh || '',
      description_en: row.descriptionen || row.descen || '',
      is_active: checkIsActive(row)
    }));
}

function normalizeMedical(rows) {
  return rows
    .filter(checkIsActive)
    .map(row => {
      const p = row.phone || row.telephone || row.contact || row.col_8 || row.col_9 || '';
      return {
        id: row.placeid || row.id || `med_${Math.random()}`,
        place_id: row.placeid || row.id || '',
        city: (row.city || '').toLowerCase().trim(),
        type: (row.type || 'medical').toLowerCase().trim(),
        name: row.namezh || row.nameen || row.name || row.id,
        name_zh: row.namezh || '',
        name_en: row.nameen || '',
        name_tl: row.nametl || '',
        category: row.category || '',
        categoryKey: (row.category || '').toLowerCase().trim(),
        google_rating: parseFloat(row.googlerating || row.rating) || 4.5,
        review_count: parseInt(row.reviewcount || row.googlereviewcount || row.reviews, 10) || 50,
        address: row.address || '',
        phone: cleanPhoneNumber(p),
        website: extractWebsite(row),
        image_url: row.imageurl || row.image || '',
        images: extractImages(row),
        nav_link: row.navlink || row.nav_link || '',
        description: row.description || row.desc || '',
        description_en: row.descriptionen || row.descen || '',
        is_active: checkIsActive(row)
      };
    });
}

/**
 * 載入 Master 資料庫核心（6 大工作表全部並行讀取）
 */
export async function loadMasterDatabase() {
  const [rawBigV, rawAttr, rawPromo, rawAuto, rawMed, rawIsland] = await Promise.allSettled([
    fetchSheetCsv(SHEET_CONFIG.sheets.bigVPicks),
    fetchSheetCsv(SHEET_CONFIG.sheets.attractions),
    fetchSheetCsv(SHEET_CONFIG.sheets.promotions),
    fetchSheetCsv(SHEET_CONFIG.sheets.autoDiscovered),
    fetchSheetCsv(SHEET_CONFIG.sheets.medical),
    fetchSheetCsv(SHEET_CONFIG.sheets.islandDiscovered)
  ]);

  return {
    bigVPicks: rawBigV.status === 'fulfilled' ? normalizeBigVPicks(rawBigV.value) : [],
    attractions: rawAttr.status === 'fulfilled' ? normalizeAttractions(rawAttr.value) : [],
    promotions: rawPromo.status === 'fulfilled' ? normalizePromotions(rawPromo.value) : [],
    autoDiscovered: rawAuto.status === 'fulfilled' ? normalizeAutoDiscovered(rawAuto.value) : [],
    medical: rawMed.status === 'fulfilled' ? normalizeMedical(rawMed.value) : [],
    islandDiscovered: rawIsland.status === 'fulfilled' ? normalizeIslandDiscovered(rawIsland.value) : []
  };
}

export function getLocalizedText(item, field, langCode = 'zh') {
  if (!item) return '';
  const keySpecific = `${field}_${langCode}`;
  if (item[keySpecific] && String(item[keySpecific]).trim()) {
    return String(item[keySpecific]).trim();
  }
  const keyZh = `${field}_zh`;
  if (item[keyZh] && String(item[keyZh]).trim()) {
    return String(item[keyZh]).trim();
  }
  const keyEn = `${field}_en`;
  if (item[keyEn] && String(item[keyEn]).trim()) {
    return String(item[keyEn]).trim();
  }
  if (item[field] && String(item[field]).trim()) {
    return String(item[field]).trim();
  }
  return '';
}
