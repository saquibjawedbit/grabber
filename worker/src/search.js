// Web search from inside the Worker — a provider chain, every tier fail-soft.
//
// Lives in its own module because both agent.js (the chat tool) and system.js (the
// planner's context) need it, and agent.js already imports system.js — importing
// agent.js back would be a cycle.
//
// Order: Serper (Google results over a plain JSON API, free 2,500 credits, works from
// datacenter IPs) → Google CSE (free 100/day) → DuckDuckGo HTML endpoints (often 202-
// challenge datacenter IPs, but cheap to try) → Wikipedia opensearch as a last resort.

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ").trim();
}

// Returns {results:[{title,url,snippet?}], note?} or {error}. Never throws.
export async function searchWeb(env, query, num = 6) {
  const q = String(query || "").trim();
  if (!q) return { error: "empty query" };

  // 1. Serper — google.serper.dev, POST with X-API-KEY. Answer boxes come back as
  //    `answerBox`; organic hits as `organic`.
  if (env.SERPER_API_KEY) {
    try {
      const r = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "X-API-KEY": env.SERPER_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ q, num }),
      });
      if (r.ok) {
        const j = await r.json();
        const results = (j.organic || []).slice(0, num).map(i => ({
          title: i.title, url: i.link, snippet: (i.snippet || "").slice(0, 200),
        }));
        if (j.answerBox?.answer || j.answerBox?.snippet) {
          results.unshift({
            title: j.answerBox.title || "Answer",
            url: j.answerBox.link || "",
            snippet: String(j.answerBox.answer || j.answerBox.snippet).slice(0, 250),
          });
        }
        if (results.length) return { results };
      }
    } catch { /* fall through */ }
  }

  // 2. Google CSE.
  if (env.GOOGLE_CSE_KEY && env.GOOGLE_CSE_ID) {
    try {
      const r = await fetch("https://www.googleapis.com/customsearch/v1?key=" + env.GOOGLE_CSE_KEY +
        "&cx=" + env.GOOGLE_CSE_ID + "&num=" + num + "&q=" + encodeURIComponent(q));
      if (r.ok) {
        const j = await r.json();
        const results = (j.items || []).map(i => ({
          title: i.title, url: i.link, snippet: (i.snippet || "").slice(0, 160),
        }));
        if (results.length) return { results };
      }
    } catch { /* fall through */ }
  }

  // 3. DuckDuckGo endpoints.
  const ddgLink = /<a[^>]*(?:class="result__a"|rel="nofollow")[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const ep of ["https://html.duckduckgo.com/html/?q=", "https://lite.duckduckgo.com/lite/?q="]) {
    try {
      const r = await fetch(ep + encodeURIComponent(q), {
        headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0" },
      });
      if (!r.ok) continue;
      const html = await r.text();
      const results = [];
      let m;
      while ((m = ddgLink.exec(html)) && results.length < num) {
        let href = m[1];
        const uddg = /uddg=([^&]+)/.exec(href);
        if (uddg) try { href = decodeURIComponent(uddg[1]); } catch { /* keep raw */ }
        if (!/^https?:\/\//.test(href) || /duckduckgo\.com/.test(href)) continue;
        const title = stripHtml(m[2]).slice(0, 120);
        if (!title || results.some(x => x.url === href)) continue;
        results.push({ title, url: href });
      }
      if (results.length) return { results };
    } catch { /* try next */ }
  }

  // 4. Wikipedia — always reachable; better than nothing for factual queries.
  try {
    const r = await fetch("https://en.wikipedia.org/w/api.php?action=opensearch&limit=5&format=json&search=" +
      encodeURIComponent(q));
    const [, titles, , urls] = await r.json();
    if (titles?.length) {
      return {
        results: titles.map((t, i) => ({ title: t, url: urls[i] })),
        note: "general search engines blocked this request; these are Wikipedia matches — web_fetch one, or fetch a site you already know",
      };
    }
  } catch { /* give up */ }
  return { error: "all search backends failed — try web_fetch on a specific URL you know" };
}
