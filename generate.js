import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ZHIPU_API_KEY = process.env.ZHIPU_API_KEY;
const ZHIPU_API_BASE = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const DAYS_BACK = parseInt(process.env.DAYS_BACK || "7", 10);
const MAX_TOKENS = 50000;
const TIMEOUT_MS = 480000;

const SEARCH_QUERIES = [
  {
    name: "Core GAD Evidence",
    term: '("Generalized Anxiety Disorder"[Mesh] OR "generalized anxiety disorder"[tiab] OR "generalised anxiety disorder"[tiab] OR "pathological worry"[tiab] OR "excessive worry"[tiab]) AND ("2026/01/01"[dp] : "3000"[dp]) AND humans[mh] NOT (animals[mh] NOT humans[mh])',
  },
  {
    name: "GAD Treatment",
    term: '("generalized anxiety disorder"[tiab] OR "generalised anxiety disorder"[tiab]) AND (CBT[tiab] OR SSRI[tiab] OR SNRI[tiab] OR pregabalin[tiab] OR buspirone[tiab] OR mindfulness[tiab] OR "metacognitive therapy"[tiab] OR "digital CBT"[tiab]) AND ("2026/01/01"[dp] : "3000"[dp]) AND humans[mh]',
  },
  {
    name: "GAD-7 Screening",
    term: '("GAD-7"[tiab] OR "GAD-2"[tiab]) AND (validation[tiab] OR screening[tiab] OR psychometric*[tiab]) AND ("2026/01/01"[dp] : "3000"[dp])',
  },
  {
    name: "GAD Neuroscience",
    term: '("generalized anxiety disorder"[tiab] OR "generalised anxiety disorder"[tiab] OR "pathological worry"[tiab]) AND (fMRI[tiab] OR EEG[tiab] OR "heart rate variability"[tiab] OR cortisol[tiab] OR inflammation[tiab] OR amygdala[tiab] OR "prefrontal cortex"[tiab] OR microbiome[tiab]) AND ("2026/01/01"[dp] : "3000"[dp])',
  },
  {
    name: "GAD Social Determinants",
    term: '("generalized anxiety disorder"[tiab] OR "generalised anxiety disorder"[tiab]) AND ("social determinants"[tiab] OR prevalence[tiab] OR epidemiology[tiab] OR inequality[tiab] OR loneliness[tiab] OR stigma[tiab] OR "primary care"[tiab]) AND ("2026/01/01"[dp] : "3000"[dp]) AND humans[mh]',
  },
];

const FALLBACK_MODELS = ["glm-5-turbo", "glm-4.7", "glm-4.7-flash"];

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve, reject);
      }
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
  });
}

async function searchPubMed(searchTerm, retmax = 20) {
  const baseUrl = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
  const params = new URLSearchParams({
    db: "pubmed",
    term: searchTerm,
    retmax: String(retmax),
    retmode: "json",
    sort: "date",
  });
  const url = `${baseUrl}?${params.toString()}`;
  const data = JSON.parse(await fetchUrl(url));
  return data.esearchresult?.idlist || [];
}

async function fetchPubMedDetails(ids) {
  if (!ids.length) return [];
  const baseUrl = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi";
  const params = new URLSearchParams({
    db: "pubmed",
    id: ids.join(","),
    retmode: "json",
  });
  const url = `${baseUrl}?${params.toString()}`;
  const data = JSON.parse(await fetchUrl(url));
  const result = data.result || {};
  const uids = result.uids || [];
  return uids.map((uid) => {
    const item = result[uid] || {};
    return {
      pmid: uid,
      title: item.title || "No title",
      source: item.source || "",
      pubdate: item.pubdate || "",
      authors: (item.authors || []).slice(0, 5).map((a) => a.name),
      fulljournalname: item.fulljournalname || item.source || "",
      elocationid: item.elocationid || "",
    };
  });
}

function callZhipuAPI(messages) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      model: "glm-5-turbo",
      messages,
      max_tokens: MAX_TOKENS,
      temperature: 0.3,
    });

    const urlObj = new URL(ZHIPU_API_BASE);

    for (const model of FALLBACK_MODELS) {
      const body = JSON.stringify({
        model,
        messages,
        max_tokens: MAX_TOKENS,
        temperature: 0.3,
      });

      const options = {
        hostname: urlObj.hostname,
        port: 443,
        path: urlObj.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ZHIPU_API_KEY}`,
        },
        timeout: TIMEOUT_MS,
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(data);
              resolve(parsed);
            } catch (e) {
              console.error(`JSON parse error with model ${model}:`, e.message);
            }
          } else {
            console.error(`Model ${model} failed: ${res.statusCode}`);
          }
        });
      });

      req.on("error", (e) => {
        console.error(`Model ${model} error:`, e.message);
      });

      req.on("timeout", () => {
        console.error(`Model ${model} timeout`);
        req.destroy();
      });

      req.write(body);
      req.end();

      return;
    }

    reject(new Error("All models failed"));
  });
}

function callZhipuWithFallback(messages) {
  return new Promise((resolve, reject) => {
    let modelIndex = 0;

    function tryNext() {
      if (modelIndex >= FALLBACK_MODELS.length) {
        return reject(new Error("All models failed"));
      }
      const model = FALLBACK_MODELS[modelIndex];
      console.log(`Trying model: ${model}`);

      const body = JSON.stringify({
        model,
        messages,
        max_tokens: MAX_TOKENS,
        temperature: 0.3,
      });

      const urlObj = new URL(ZHIPU_API_BASE);
      const options = {
        hostname: urlObj.hostname,
        port: 443,
        path: urlObj.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ZHIPU_API_KEY}`,
          "Content-Length": Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(data);
              if (parsed.choices && parsed.choices[0]) {
                console.log(`Success with model: ${model}`);
                return resolve(parsed);
              }
              console.error(`No choices from ${model}, trying next...`);
              modelIndex++;
              tryNext();
            } catch (e) {
              console.error(`JSON parse error from ${model}:`, e.message);
              modelIndex++;
              tryNext();
            }
          } else {
            console.error(`Model ${model} returned ${res.statusCode}: ${data.substring(0, 200)}`);
            modelIndex++;
            tryNext();
          }
        });
      });

      req.on("error", (e) => {
        console.error(`Model ${model} error:`, e.message);
        modelIndex++;
        tryNext();
      });

      req.on("timeout", () => {
        console.error(`Model ${model} timeout after ${TIMEOUT_MS}ms`);
        req.destroy();
        modelIndex++;
        tryNext();
      });

      req.setTimeout(TIMEOUT_MS);
      req.write(body);
      req.end();
    }

    tryNext();
  });
}

function loadSummarizedPmids() {
  const docsDir = path.join(process.cwd(), "docs");
  const pmids = new Set();
  if (!fs.existsSync(docsDir)) return pmids;
  const files = fs.readdirSync(docsDir).filter((f) => f.startsWith("gad-") && f.endsWith(".html"));
  for (const file of files) {
    const filePath = path.join(docsDir, file);
    const content = fs.readFileSync(filePath, "utf-8");
    const matches = content.matchAll(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/g);
    for (const m of matches) {
      pmids.add(m[1]);
    }
  }
  return pmids;
}

function getDateRange() {
  const now = new Date();
  const to = now.toISOString().split("T")[0];
  const from = new Date(now.getTime() - DAYS_BACK * 86400000).toISOString().split("T")[0];
  return { from, to };
}

function getTaiwanDateString(date = new Date()) {
  const weekdays = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const w = weekdays[date.getDay()];
  return `${y}年${m}月${d}日（${w}）`;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function generateDailyHTML(dateStr, taiwanDate, data) {
  const safeDateStr = escapeHtml(dateStr);
  const safeTaiwanDate = escapeHtml(taiwanDate);
  let summaryHtml = "";
  let topPicksHtml = "";
  let otherHtml = "";
  let topicHtml = "";
  let keywordsHtml = "";

  try {
    const summary = data.summary || "今日無法取得文獻摘要。";
    summaryHtml = `<p class="summary-text">${escapeHtml(summary)}</p>`;

    const topPicks = data.top_picks || [];
    topPicksHtml = topPicks
      .map(
        (item, i) => `
        <div class="news-card featured">
          <div class="card-header">
            <span class="rank-badge">#${i + 1}</span>
            <span class="emoji-icon">${escapeHtml(item.emoji || "📄")}</span>
            <span class="${item.utility === "high" ? "utility-high" : item.utility === "mid" ? "utility-mid" : "utility-low"}">${item.utility === "high" ? "高實用性" : item.utility === "mid" ? "中實用性" : "低實用性"}</span>
          </div>
          <h3>${escapeHtml(item.title_zh || item.title || "")}</h3>
          <p class="journal-source">${escapeHtml(item.journal || "")} &middot; ${escapeHtml(item.title || "")}</p>
          <p>${escapeHtml(item.summary_zh || "")}</p>
          ${item.pico ? `<div class="pico-grid">
            <div class="pico-item"><span class="pico-label">P</span><span class="pico-text">${escapeHtml(item.pico.P || "")}</span></div>
            <div class="pico-item"><span class="pico-label">I</span><span class="pico-text">${escapeHtml(item.pico.I || "")}</span></div>
            <div class="pico-item"><span class="pico-label">C</span><span class="pico-text">${escapeHtml(item.pico.C || "")}</span></div>
            <div class="pico-item"><span class="pico-label">O</span><span class="pico-text">${escapeHtml(item.pico.O || "")}</span></div>
          </div>` : ""}
          <div class="card-footer">
            ${(item.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")}
            ${item.pmid ? `<a href="https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(item.pmid)}/" target="_blank">閱讀原文 →</a>` : ""}
          </div>
        </div>`
      )
      .join("");

    const others = data.other_articles || [];
    otherHtml = others
      .map(
        (item) => `
        <div class="news-card">
          <div class="card-header-row">
            <span class="emoji-sm">${escapeHtml(item.emoji || "📄")}</span>
            <span class="${item.utility === "high" ? "utility-high" : item.utility === "mid" ? "utility-mid" : "utility-low"} utility-sm">${item.utility === "high" ? "高" : item.utility === "mid" ? "中" : "低"}</span>
          </div>
          <h3>${escapeHtml(item.title_zh || item.title || "")}</h3>
          <p class="journal-source">${escapeHtml(item.journal || "")}</p>
          <p>${escapeHtml(item.summary_zh || "")}</p>
          <div class="card-footer">
            ${(item.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")}
            ${item.pmid ? `<a href="https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(item.pmid)}/" target="_blank">PubMed →</a>` : ""}
          </div>
        </div>`
      )
      .join("");

    const topics = data.topic_distribution || [];
    const maxCount = Math.max(...topics.map((t) => t.count), 1);
    topicHtml = topics
      .map(
        (t) => `
        <div class="topic-row">
          <span class="topic-name">${escapeHtml(t.name)}</span>
          <div class="topic-bar-bg"><div class="topic-bar" style="width:${Math.round((t.count / maxCount) * 100)}%"></div></div>
          <span class="topic-count">${t.count}</span>
        </div>`
      )
      .join("");

    const keywords = data.keywords || [];
    keywordsHtml = keywords.map((k) => `<span class="keyword">${escapeHtml(k)}</span>`).join("");

    const modelUsed = data.model_used || "glm-5-turbo";
  } catch (e) {
    console.error("Error generating HTML sections:", e.message);
  }

  const totalArticles = (data.top_picks?.length || 0) + (data.other_articles?.length || 0);
  const modelUsed = data.model_used || "glm-5-turbo";

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>GAD Research Daily &middot; 廣泛性焦慮症文獻日報 &middot; ${safeTaiwanDate}</title>
<meta name="description" content="${safeTaiwanDate} 廣泛性焦慮症文獻日報，由 AI 自動彙整 PubMed 最新論文"/>
<style>
  :root { --bg: #f6f1e8; --surface: #fffaf2; --line: #d8c5ab; --text: #2b2118; --muted: #766453; --accent: #8c4f2b; --accent-soft: #ead2bf; --card-bg: color-mix(in srgb, var(--surface) 92%, white); }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: radial-gradient(circle at top, #fff6ea 0, var(--bg) 55%, #ead8c6 100%); color: var(--text); font-family: "Noto Sans TC", "PingFang TC", "Helvetica Neue", Arial, sans-serif; min-height: 100vh; overflow-x: hidden; }
  .container { position: relative; z-index: 1; max-width: 880px; margin: 0 auto; padding: 60px 32px 80px; }
  header { display: flex; align-items: center; gap: 16px; margin-bottom: 52px; animation: fadeDown 0.6s ease both; }
  .logo { width: 48px; height: 48px; border-radius: 14px; background: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 22px; flex-shrink: 0; box-shadow: 0 4px 20px rgba(140,79,43,0.25); }
  .header-text h1 { font-size: 22px; font-weight: 700; color: var(--text); letter-spacing: -0.3px; }
  .header-meta { display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; align-items: center; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 11px; letter-spacing: 0.3px; }
  .badge-date { background: var(--accent-soft); border: 1px solid var(--line); color: var(--accent); }
  .badge-count { background: rgba(140,79,43,0.06); border: 1px solid var(--line); color: var(--muted); }
  .badge-source { background: transparent; color: var(--muted); font-size: 11px; padding: 0 4px; }
  .summary-card { background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; padding: 28px 32px; margin-bottom: 32px; box-shadow: 0 20px 60px rgba(61,36,15,0.06); animation: fadeUp 0.5s ease 0.1s both; }
  .summary-card h2 { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.6px; color: var(--accent); margin-bottom: 16px; }
  .summary-text { font-size: 15px; line-height: 1.8; color: var(--text); }
  .section { margin-bottom: 36px; animation: fadeUp 0.5s ease both; }
  .section-title { display: flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 700; color: var(--text); margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
  .section-icon { width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0; background: var(--accent-soft); }
  .news-card { background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; padding: 22px 26px; margin-bottom: 12px; box-shadow: 0 8px 30px rgba(61,36,15,0.04); transition: background 0.2s, border-color 0.2s, transform 0.2s; }
  .news-card:hover { transform: translateY(-2px); box-shadow: 0 12px 40px rgba(61,36,15,0.08); }
  .news-card.featured { border-left: 3px solid var(--accent); }
  .news-card.featured:hover { border-color: var(--accent); }
  .card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .rank-badge { background: var(--accent); color: #fff7f0; font-weight: 700; font-size: 12px; padding: 2px 8px; border-radius: 6px; }
  .emoji-icon { font-size: 18px; }
  .card-header-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .emoji-sm { font-size: 14px; }
  .news-card h3 { font-size: 15px; font-weight: 600; color: var(--text); margin-bottom: 8px; line-height: 1.5; }
  .journal-source { font-size: 12px; color: var(--accent); margin-bottom: 8px; opacity: 0.8; }
  .news-card p { font-size: 13.5px; line-height: 1.75; color: var(--muted); }
  .card-footer { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .tag { padding: 2px 9px; background: var(--accent-soft); border-radius: 999px; font-size: 11px; color: var(--accent); }
  .news-card a { font-size: 12px; color: var(--accent); text-decoration: none; opacity: 0.7; margin-left: auto; }
  .news-card a:hover { opacity: 1; }
  .utility-high { color: #5a7a3a; font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(90,122,58,0.1); border-radius: 4px; }
  .utility-mid { color: #9f7a2e; font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(159,122,46,0.1); border-radius: 4px; }
  .utility-low { color: var(--muted); font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(118,100,83,0.08); border-radius: 4px; }
  .utility-sm { font-size: 10px; }
  .pico-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; padding: 12px; background: rgba(255,253,249,0.8); border-radius: 14px; border: 1px solid var(--line); }
  .pico-item { display: flex; gap: 8px; align-items: baseline; }
  .pico-label { font-size: 10px; font-weight: 700; color: #fff7f0; background: var(--accent); padding: 2px 6px; border-radius: 4px; flex-shrink: 0; }
  .pico-text { font-size: 12px; color: var(--muted); line-height: 1.4; }
  .keywords-section { margin-bottom: 36px; }
  .keywords { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .keyword { padding: 5px 14px; background: var(--accent-soft); border: 1px solid var(--line); border-radius: 20px; font-size: 12px; color: var(--accent); cursor: default; transition: background 0.2s; }
  .keyword:hover { background: rgba(140,79,43,0.18); }
  .topic-section { margin-bottom: 36px; }
  .topic-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .topic-name { font-size: 13px; color: var(--muted); width: 100px; flex-shrink: 0; text-align: right; }
  .topic-bar-bg { flex: 1; height: 8px; background: var(--line); border-radius: 4px; overflow: hidden; }
  .topic-bar { height: 100%; background: linear-gradient(90deg, var(--accent), #c47a4a); border-radius: 4px; transition: width 0.6s ease; }
  .topic-count { font-size: 12px; color: var(--accent); width: 24px; }
  .clinic-banner { margin-top: 48px; animation: fadeUp 0.5s ease 0.4s both; }
  .clinic-link { display: flex; align-items: center; gap: 14px; padding: 18px 24px; background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; text-decoration: none; color: var(--text); transition: all 0.2s; box-shadow: 0 8px 30px rgba(61,36,15,0.04); margin-bottom: 12px; }
  .clinic-link:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 12px 40px rgba(61,36,15,0.08); }
  .clinic-icon { font-size: 28px; flex-shrink: 0; }
  .clinic-name { font-size: 15px; font-weight: 700; color: var(--text); flex: 1; }
  .clinic-arrow { font-size: 18px; color: var(--accent); font-weight: 700; }
  footer { margin-top: 32px; padding-top: 22px; border-top: 1px solid var(--line); font-size: 11.5px; color: var(--muted); display: flex; justify-content: space-between; animation: fadeUp 0.5s ease 0.5s both; }
  footer a { color: var(--muted); text-decoration: none; }
  footer a:hover { color: var(--accent); }
  @keyframes fadeDown { from { opacity: 0; transform: translateY(-16px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  @media (max-width: 600px) { .container { padding: 36px 18px 60px; } .summary-card, .news-card { padding: 20px 18px; } .pico-grid { grid-template-columns: 1fr; } footer { flex-direction: column; gap: 6px; text-align: center; } .topic-name { width: 70px; font-size: 11px; } }
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="logo">😰</div>
    <div class="header-text">
      <h1>GAD Research Daily &middot; 廣泛性焦慮症文獻日報</h1>
      <div class="header-meta">
        <span class="badge badge-date">📅 ${safeTaiwanDate}</span>
        <span class="badge badge-count">📊 ${totalArticles} 篇文獻</span>
        <span class="badge badge-source">Powered by PubMed + Zhipu AI</span>
      </div>
    </div>
  </header>

  <div class="summary-card">
    <h2>📋 今日文獻趨勢</h2>
    ${summaryHtml}
  </div>

  ${topPicksHtml ? `<div class='section'><div class='section-title'><span class='section-icon'>⭐</span>今日精選 TOP Picks</div>${topPicksHtml}</div>` : ""}

  ${otherHtml ? `<div class='section'><div class='section-title'><span class='section-icon'>📚</span>其他值得關注的文獻</div>${otherHtml}</div>` : ""}

  ${topicHtml ? `<div class='topic-section section'><div class='section-title'><span class='section-icon'>📊</span>主題分佈</div>${topicHtml}</div>` : ""}

  ${keywordsHtml ? `<div class='keywords-section section'><div class='section-title'><span class='section-icon'>🏷️</span>關鍵字</div><div class='keywords'>${keywordsHtml}</div></div>` : ""}

  <div class="clinic-banner">
    <a href="https://www.leepsyclinic.com/" class="clinic-link" target="_blank">
      <span class="clinic-icon">🏥</span>
      <span class="clinic-name">李政洋身心診所首頁</span>
      <span class="clinic-arrow">→</span>
    </a>
    <a href="https://blog.leepsyclinic.com/" class="clinic-link" target="_blank">
      <span class="clinic-icon">📬</span>
      <span class="clinic-name">訂閱電子報</span>
      <span class="clinic-arrow">→</span>
    </a>
    <a href="https://buymeacoffee.com/CYlee" class="clinic-link" target="_blank">
      <span class="clinic-icon">☕</span>
      <span class="clinic-name">Buy me a coffee</span>
      <span class="clinic-arrow">→</span>
    </a>
  </div>

  <footer>
    <span>資料來源：PubMed &middot; 分析模型：${escapeHtml(modelUsed)}</span>
    <span><a href="https://github.com/u8901006/generalized-anxiety-disoder">GitHub</a> &middot; <a href="index.html">回首頁</a></span>
  </footer>
</div>
</body>
</html>`;
}

function generateIndexHTML(existingFiles) {
  const items = existingFiles
    .filter((f) => f.startsWith("gad-") && f.endsWith(".html"))
    .sort()
    .reverse()
    .map((f) => {
      const datePart = f.replace("gad-", "").replace(".html", "");
      const parts = datePart.split("-");
      const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
      const w = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"][d.getDay()];
      const label = `${parts[0]}年${parseInt(parts[1])}月${parseInt(parts[2])}日（${w}）`;
      return `<li><a href="${escapeHtml(f)}">📅 ${escapeHtml(label)}</a></li>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>GAD Research Daily &middot; 廣泛性焦慮症文獻日報</title>
<style>
  :root { --bg: #f6f1e8; --surface: #fffaf2; --line: #d8c5ab; --text: #2b2118; --muted: #766453; --accent: #8c4f2b; --accent-soft: #ead2bf; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: radial-gradient(circle at top, #fff6ea 0, var(--bg) 55%, #ead8c6 100%); color: var(--text); font-family: "Noto Sans TC", "PingFang TC", "Helvetica Neue", Arial, sans-serif; min-height: 100vh; }
  .container { position: relative; z-index: 1; max-width: 640px; margin: 0 auto; padding: 80px 24px; }
  .logo { font-size: 48px; text-align: center; margin-bottom: 16px; }
  h1 { text-align: center; font-size: 24px; color: var(--text); margin-bottom: 8px; }
  .subtitle { text-align: center; color: var(--accent); font-size: 14px; margin-bottom: 48px; }
  .count { text-align: center; color: var(--muted); font-size: 13px; margin-bottom: 32px; }
  ul { list-style: none; }
  li { margin-bottom: 8px; }
  a { color: var(--text); text-decoration: none; display: block; padding: 14px 20px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; transition: all 0.2s; font-size: 15px; }
  a:hover { background: var(--accent-soft); border-color: var(--accent); transform: translateX(4px); }
  footer { margin-top: 56px; text-align: center; font-size: 12px; color: var(--muted); }
  footer a { display: inline; padding: 0; background: none; border: none; color: var(--muted); }
  footer a:hover { color: var(--accent); }
</style>
</head>
<body>
<div class="container">
  <div class="logo">😰</div>
  <h1>GAD Research Daily</h1>
  <p class="subtitle">廣泛性焦慮症文獻日報 · 每日自動更新</p>
  <p class="count">共 ${existingFiles.filter((f) => f.startsWith("gad-")).length} 期日報</p>
  <ul>${items}</ul>
  <footer>
    <p>Powered by PubMed + Zhipu AI · <a href="https://github.com/u8901006/generalized-anxiety-disoder">GitHub</a></p>
    <p style="margin-top:8px"><a href="https://www.leepsyclinic.com/" target="_blank">李政洋身心診所</a> · <a href="https://blog.leepsyclinic.com/" target="_blank">訂閱電子報</a> · <a href="https://buymeacoffee.com/CYlee" target="_blank">☕ Buy me a coffee</a></p>
  </footer>
</div>
</body>
</html>`;
}

async function main() {
  console.log("=== GAD Research Daily Generator ===");
  console.log(`Days back: ${DAYS_BACK}`);

  if (!ZHIPU_API_KEY) {
    console.error("ERROR: ZHIPU_API_KEY environment variable is required");
    process.exit(1);
  }

  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];
  const taiwanDate = getTaiwanDateString(now);
  console.log(`Date: ${dateStr} (${taiwanDate})`);

  const summarizedPmids = loadSummarizedPmids();
  console.log(`Already summarized PMIDs: ${summarizedPmids.size}`);

  const allPmids = new Set();
  for (const query of SEARCH_QUERIES) {
    console.log(`Searching: ${query.name}`);
    try {
      const ids = await searchPubMed(query.term, 30);
      for (const id of ids) {
        if (!summarizedPmids.has(id)) {
          allPmids.add(id);
        }
      }
      console.log(`  Found ${ids.length} articles, ${ids.filter((id) => !summarizedPmids.has(id)).length} new`);
    } catch (e) {
      console.error(`  Search failed for ${query.name}:`, e.message);
    }
  }

  const newPmids = [...allPmids];
  console.log(`Total new articles to summarize: ${newPmids.length}`);

  if (newPmids.length === 0) {
    console.log("No new articles found. Exiting.");
    return;
  }

  const articles = await fetchPubMedDetails(newPmids.slice(0, 50));
  console.log(`Fetched details for ${articles.length} articles`);

  const articlesText = articles
    .map(
      (a) =>
        `PMID: ${a.pmid}\nTitle: ${a.title}\nJournal: ${a.fulljournalname}\nDate: ${a.pubdate}\nAuthors: ${a.authors.join(", ")}`
    )
    .join("\n\n");

  const systemPrompt = `你是一位專業的精神醫學文獻分析師，專精於廣泛性焦慮症（GAD）研究。請分析以下 PubMed 文獻，並以嚴格的 JSON 格式回覆。

要求：
1. 閱讀所有文獻，挑選出最值得關注的 TOP 5 文獻
2. 為每篇文獻提供繁體中文摘要
3. 評估臨床實用性（high/mid/low）
4. 進行主題分類
5. 提供今日文獻趨勢總結

請嚴格按以下 JSON 格式回覆（不要加入 markdown code block 或任何其他文字）：
{
  "summary": "今日文獻趨勢的繁體中文總結，200字以內",
  "top_picks": [
    {
      "pmid": "PMID數字",
      "title": "原始英文標題",
      "title_zh": "繁體中文標題翻譯",
      "journal": "期刊名稱",
      "summary_zh": "繁體中文摘要，含研究發現",
      "emoji": "一個emoji",
      "utility": "high或mid或low",
      "tags": ["標籤1", "標籤2", "標籤3"],
      "pico": {"P": "Population", "I": "Intervention", "C": "Comparison", "O": "Outcome"}
    }
  ],
  "other_articles": [
    {
      "pmid": "PMID數字",
      "title": "原始英文標題",
      "title_zh": "繁體中文標題",
      "journal": "期刊名稱",
      "summary_zh": "簡短中文摘要",
      "emoji": "一個emoji",
      "utility": "high或mid或low",
      "tags": ["標籤1", "標籤2"]
    }
  ],
  "topic_distribution": [
    {"name": "主題名稱", "count": 數字}
  ],
  "keywords": ["關鍵字1", "關鍵字2"]
}`;

  const userPrompt = `以下是今天從 PubMed 抓取的廣泛性焦慮症（GAD）相關文獻：

${articlesText}

請分析這些文獻，按指定 JSON 格式回覆。`;

  console.log("Calling Zhipu AI for analysis...");
  let aiResult;
  try {
    aiResult = await callZhipuWithFallback([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ]);
  } catch (e) {
    console.error("All AI models failed:", e.message);
    process.exit(1);
  }

  const content = aiResult.choices?.[0]?.message?.content || "";
  console.log("AI response length:", content.length);

  let parsed;
  try {
    let jsonStr = content.trim();
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    console.error("JSON parse error:", e.message);
    console.log("Raw response (first 500 chars):", content.substring(0, 500));
    parsed = {
      summary: "今日文獻分析暫時無法完成。",
      top_picks: [],
      other_articles: articles.map((a) => ({
        pmid: a.pmid,
        title: a.title,
        title_zh: a.title,
        journal: a.fulljournalname,
        summary_zh: "摘要暫時無法取得。",
        emoji: "📄",
        utility: "mid",
        tags: ["GAD"],
      })),
      topic_distribution: [],
      keywords: ["廣泛性焦慮症", "GAD"],
    };
  }

  const usedModel = aiResult.model || "glm-5-turbo";
  parsed.model_used = usedModel;

  const docsDir = path.join(process.cwd(), "docs");
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }

  const dailyHtml = generateDailyHTML(dateStr, taiwanDate, parsed);
  const dailyFile = path.join(docsDir, `gad-${dateStr}.html`);
  fs.writeFileSync(dailyFile, dailyHtml, "utf-8");
  console.log(`Generated daily report: ${dailyFile}`);

  const existingFiles = fs.readdirSync(docsDir).filter((f) => f.endsWith(".html"));
  const indexHtml = generateIndexHTML(existingFiles);
  fs.writeFileSync(path.join(docsDir, "index.html"), indexHtml, "utf-8");
  console.log("Updated index.html");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
