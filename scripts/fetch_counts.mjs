import fs from 'fs/promises';
import { chromium } from 'playwright';

const JOBS_JSON = 'data/jobs-last10d.json';
const ELG_JSON = 'rules/eligibility-462.json';

function expandRanges(ranges) {
  // "2311-2312","3139" => ["2311","2312","3139"]
  const out = new Set();
  (ranges || []).forEach(s => {
    if (!s) return;
    if (s.includes('-')) {
      const [a,b] = s.split('-').map(x=>parseInt(x,10));
      for (let x=a;x<=b;x++) out.add(String(x).padStart(4,'0'));
    } else {
      out.add(String(s).padStart(4,'0'));
    }
  });
  return Array.from(out);
}

async function ensureExpanded() {
  const text = await fs.readFile(ELG_JSON,'utf8');
  const elg = JSON.parse(text);

  // 展开 regional
  const reg = [];
  for (const [state, segs] of Object.entries(elg.definitions.regionalAustralia)) {
    if (segs.includes('ALL')) { continue; } // ALL 由脚本按 ABS POA 2021 归类可补充
    reg.push(...expandRanges(segs));
  }
  elg.definitions.regionalAustraliaFlat = Array.from(new Set(reg));

  // 展开 remote & very remote
  const rvr = [];
  for (const [state, segs] of Object.entries(elg.definitions.remoteVeryRemoteByState)) {
    if (!segs || !segs.length) continue;
    if (segs.includes('ALL')) { continue; }
    rvr.push(...expandRanges(segs));
  }
  // 远程/极远合并四个旅游酒店特例邮编
  elg.definitions.remoteVeryRemoteFlat = Array.from(new Set([...rvr, ...elg.definitions.tourismExtraPostcodes]));

  await fs.writeFile(ELG_JSON, JSON.stringify(elg,null,2));
  return elg;
}

async function fetchWorkforceCounts(poaList){
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  // Workforce Australia 搜索入口（官方）
  await page.goto('https://www.workforceaustralia.gov.au/individuals/jobs/search', { waitUntil: 'load' });

  // 打开筛选：Job Age => Past fortnight（站内可选 3 天/1 周/2 周）
  // 由于站点为 SPA，具体选择器可能随时间变化；这里用文本点击 + 回退逻辑
  try {
    await page.getByText('Job Age').click({ timeout: 15000 });
    await page.getByRole('option', { name: /Past fortnight/i }).click({ timeout: 15000 });
  } catch(e){ /* 忽略，保持默认也可 */ }

  // 准备结果容器
  const counts = {};
  for (const poa of poaList) counts[poa] = 0;

  // 我们按行业关键词分组（仅用于过滤“可能计入 462 指定工作”的岗位；行业精确性以 462 规则为准）
  const keywordGroups = [
    // 旅游酒店
    ['hotel','hostel','motel','resort','reception','housekeeping','bar','restaurant','cafe','chef','cook','waiter','bartender','tour','guide','museum','gallery'],
    // 植物与动物栽培
    ['farm','orchard','harvest','picker','packing','vineyard','pruning','vegetable','fruit','cattle','shear','dairy'],
    // 建筑
    ['construction','labourer','carpenter','plumber','electrician','painter','tiler','bricklayer','concretor','scaffolder'],
    // 渔业/珍珠、林业
    ['fishing','deckhand','pearling','forestry','logging','tree felling'],
    // 灾后恢复
    ['recovery','disaster','clean-up','restoration','reconstruction']
  ];

  // 简化方案：直接在站内搜索框循环关键字+邮编，抓取“公告卡片时间”<=10天的条数
  for (const words of keywordGroups) {
    const q = words.join(' OR ');
    for (const poa of poaList) {
      // 在搜索框输入：关键词 + 邮编
      await page.goto('https://www.workforceaustralia.gov.au/individuals/jobs/search', { waitUntil:'load' });
      const inputKeyword = page.locator('input[aria-label="Keyword"]');
      const inputLocation = page.locator('input[aria-label="Enter location"]');

      await inputKeyword.fill(q);
      await inputLocation.fill(poa);
      await page.keyboard.press('Enter');
      await page.waitForLoadState('networkidle', { timeout: 20000 });

      // 逐页抓卡片发布时间（例如 “Added 5 days ago” 或日期），10天内计数
      let hasNext = true;
      let pages = 0;
      while (hasNext && pages < 5) { // 每个组合最多翻 5 页以控制时长
        await page.waitForTimeout(1500);
        const items = await page.locator('[data-testid^="job-card"]').all();
        for (const it of items) {
          const meta = await it.innerText().catch(()=> '');
          const daysMatch = meta.match(/(\d+)\s+day(s)?\s+ago/i);
          let within10 = false;
          if (daysMatch) {
            within10 = parseInt(daysMatch[1],10) <= 10;
          } else if (/Added|Posted/i.test(meta)) {
            // 如果是“Today/Yesterday”等
            if (/Today|Yesterday/i.test(meta)) within10 = true;
          }
          if (within10) counts[poa] = (counts[poa]||0) + 1;
        }
        // 下一页
        const nextBtn = page.getByRole('button',{ name: /Next/i });
        hasNext = await nextBtn.isEnabled().catch(()=>false);
        if (hasNext) { await nextBtn.click(); pages++; }
      }
    }
  }

  await browser.close();
  return counts;
}

function uniquePOAFromEligibility(elg){
  const s = new Set([
    ...elg.definitions.northernAustralia.postcodes,
    ...elg.definitions.regionalAustraliaFlat,
    ...elg.definitions.remoteVeryRemoteFlat,
    ...elg.definitions.tourismExtraPostcodes
  ]);
  return Array.from(s);
}

(async()=>{
  const elg = await ensureExpanded();
  const poaList = uniquePOAFromEligibility(elg);

  const counts = await fetchWorkforceCounts(poaList);

  const out = { generatedAtUTC: new Date().toISOString(), sources:["Workforce Australia"], perPOA:{} };
  for (const poa of poaList) {
    out.perPOA[poa] = { count: counts[poa] || 0 };
  }
  await fs.writeFile(JOBS_JSON, JSON.stringify(out,null,2));
  console.log('Updated', JOBS_JSON);
})();
