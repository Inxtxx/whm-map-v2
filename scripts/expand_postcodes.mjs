import fs from 'fs/promises';
const ELG_JSON = 'rules/eligibility-462.json';
const expandRanges = (ranges=[]) => {
  const out = new Set();
  for (const s of ranges) {
    if (s==='ALL') continue;
    if (s.includes('-')) {
      const [a,b] = s.split('-').map(x=>parseInt(x,10));
      for (let x=a;x<=b;x++) out.add(String(x).padStart(4,'0'));
    } else {
      out.add(String(s).padStart(4,'0'));
    }
  }
  return Array.from(out);
};

(async()=>{
  const elg = JSON.parse(await fs.readFile(ELG_JSON,'utf8'));
  const reg = [];
  for (const segs of Object.values(elg.definitions.regionalAustralia)) {
    reg.push(...expandRanges(segs));
  }
  elg.definitions.regionalAustraliaFlat = Array.from(new Set(reg));
  const rvr = [];
  for (const segs of Object.values(elg.definitions.remoteVeryRemoteByState)) {
    rvr.push(...expandRanges(segs));
  }
  elg.definitions.remoteVeryRemoteFlat = Array.from(new Set([...rvr, ...elg.definitions.tourismExtraPostcodes]));
  await fs.writeFile(ELG_JSON, JSON.stringify(elg,null,2));
  console.log('Expanded postcodes written.');
})();
