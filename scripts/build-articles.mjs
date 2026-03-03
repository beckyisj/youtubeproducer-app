#!/usr/bin/env node

/**
 * Fetches articles from Notion and generates static HTML pages.
 * No dependencies — uses native fetch (Node 22).
 *
 * Usage: node scripts/build-articles.mjs
 */

import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

// Read Notion token from ~/.claude/settings.json (same source as MCP)
const settings = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'));
const NOTION_TOKEN = settings.mcpServers?.['notion']?.env?.OPENAPI_MCP_HEADERS
  ? JSON.parse(settings.mcpServers['notion'].env.OPENAPI_MCP_HEADERS)?.Authorization?.replace('Bearer ', '')
  : process.env.NOTION_TOKEN;

if (!NOTION_TOKEN) throw new Error('Could not find Notion token in ~/.claude/settings.json or NOTION_TOKEN env var');

const DB_ID = '3187c4eb-5b68-8150-aeee-defce0820878';
const SITE_URL = 'https://youtubeproducer.app';
const GA_ID = 'G-75ZD55B9SQ';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Notion API helpers ──────────────────────────────────────────────

async function notionFetch(path, body) {
  const opts = {
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
  };
  if (body) {
    opts.method = 'POST';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`https://api.notion.com/v1${path}`, opts);
  if (!res.ok) throw new Error(`Notion ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function fetchArticles() {
  const data = await notionFetch(`/databases/${DB_ID}/query`, {
    sorts: [{ property: 'Name', direction: 'ascending' }],
  });
  return data.results.map(page => {
    const props = page.properties;
    const title = props.Name?.title?.[0]?.text?.content || 'Untitled';
    const slug = props.Slug?.rich_text?.[0]?.text?.content || title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const type = props.Type?.select?.name || 'Article';
    const status = props.Status?.select?.name || 'Draft';
    const created = page.created_time?.split('T')[0] || '2026-03-03';
    return { id: page.id, title, slug, type, status, created };
  });
}

async function fetchBlocks(pageId) {
  let blocks = [];
  let cursor;
  do {
    const params = cursor ? `?start_cursor=${cursor}` : '';
    const data = await notionFetch(`/blocks/${pageId}/children${params}`);
    blocks.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return blocks;
}

// ── Rich text → HTML ────────────────────────────────────────────────

function richTextToHtml(richTextArray) {
  if (!richTextArray?.length) return '';
  return richTextArray.map(rt => {
    let text = escapeHtml(rt.plain_text);
    if (rt.annotations?.bold) text = `<strong>${text}</strong>`;
    if (rt.annotations?.italic) text = `<em>${text}</em>`;
    if (rt.annotations?.strikethrough) text = `<s>${text}</s>`;
    if (rt.annotations?.code) text = `<code>${text}</code>`;
    if (rt.href) text = `<a href="${escapeHtml(rt.href)}" target="_blank" rel="noopener">${text}</a>`;
    return text;
  }).join('');
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Blocks → HTML (with list grouping) ──────────────────────────────

function blocksToHtml(blocks) {
  const parts = [];
  let i = 0;

  while (i < blocks.length) {
    const block = blocks[i];
    const type = block.type;

    // Group consecutive list items
    if (type === 'bulleted_list_item') {
      const items = [];
      while (i < blocks.length && blocks[i].type === 'bulleted_list_item') {
        items.push(`<li>${richTextToHtml(blocks[i].bulleted_list_item.rich_text)}</li>`);
        i++;
      }
      parts.push(`<ul>${items.join('\n')}</ul>`);
      continue;
    }

    if (type === 'numbered_list_item') {
      const items = [];
      while (i < blocks.length && blocks[i].type === 'numbered_list_item') {
        items.push(`<li>${richTextToHtml(blocks[i].numbered_list_item.rich_text)}</li>`);
        i++;
      }
      parts.push(`<ol>${items.join('\n')}</ol>`);
      continue;
    }

    switch (type) {
      case 'paragraph': {
        const html = richTextToHtml(block.paragraph.rich_text);
        if (html) parts.push(`<p>${html}</p>`);
        break;
      }
      case 'heading_2':
        parts.push(`<h2>${richTextToHtml(block.heading_2.rich_text)}</h2>`);
        break;
      case 'heading_3':
        parts.push(`<h3>${richTextToHtml(block.heading_3.rich_text)}</h3>`);
        break;
      case 'callout': {
        const emoji = block.callout.icon?.emoji || '';
        const text = richTextToHtml(block.callout.rich_text);
        parts.push(`<div class="callout">${emoji ? `<span class="callout-icon">${emoji}</span>` : ''}${text}</div>`);
        break;
      }
      case 'divider':
        parts.push('<hr>');
        break;
      case 'quote':
        parts.push(`<blockquote>${richTextToHtml(block.quote.rich_text)}</blockquote>`);
        break;
      default:
        // Skip unsupported block types
        break;
    }
    i++;
  }

  return parts.join('\n');
}

// ── Extract excerpt from first meaningful block ─────────────────────

function extractExcerpt(blocks) {
  for (const block of blocks) {
    const type = block.type;
    if (type === 'callout') {
      const text = block.callout.rich_text?.map(rt => rt.plain_text).join('') || '';
      if (text.length > 20) return text.slice(0, 160).replace(/\s+\S*$/, '') + '...';
    }
    if (type === 'paragraph') {
      const text = block.paragraph.rich_text?.map(rt => rt.plain_text).join('') || '';
      if (text.length > 20) return text.slice(0, 160).replace(/\s+\S*$/, '') + '...';
    }
  }
  return '';
}

// ── Format date ─────────────────────────────────────────────────────

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

// ── HTML Templates ──────────────────────────────────────────────────

function articlePageHtml(article, contentHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(article.title)} — YouTube Producer</title>
  <meta name="description" content="${escapeHtml(article.excerpt)}">
  <meta property="og:title" content="${escapeHtml(article.title)} — YouTube Producer">
  <meta property="og:description" content="${escapeHtml(article.excerpt)}">
  <meta property="og:url" content="${SITE_URL}/articles/${article.slug}">
  <meta property="og:image" content="${SITE_URL}/og-image.png">
  <meta property="og:type" content="article">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(article.title)} — YouTube Producer">
  <meta name="twitter:description" content="${escapeHtml(article.excerpt)}">
  <meta name="twitter:image" content="${SITE_URL}/og-image.png">
  <link rel="icon" href="/favicon.ico" sizes="32x32">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <!-- Google tag (gtag.js) -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', '${GA_ID}');
  </script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg: #fafaf9;
      --bg-surface: #ffffff;
      --bg-subtle: #f5f5f4;
      --border: #e7e5e4;
      --text: #1c1917;
      --text-secondary: #78716c;
      --text-muted: #a8a29e;
      --accent: #0d9488;
      --accent-hover: #0f766e;
    }
    body {
      font-family: 'Manrope', -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
    }
    .container { max-width: 680px; margin: 0 auto; padding: 60px 24px 80px; }
    .back { display: inline-block; margin-bottom: 24px; font-size: 0.9rem; color: var(--text-secondary); text-decoration: none; }
    .back:hover { color: var(--accent); }
    .article-badge {
      display: inline-block;
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      padding: 4px 10px;
      border-radius: 100px;
      margin-bottom: 12px;
    }
    .badge-data { background: rgba(124, 58, 237, 0.08); color: #7c3aed; }
    .badge-guide { background: rgba(13, 148, 136, 0.08); color: #0d9488; }
    .article-title { font-size: 2rem; font-weight: 700; letter-spacing: -0.03em; margin-bottom: 8px; line-height: 1.2; }
    .article-meta { font-size: 0.9rem; color: var(--text-muted); margin-bottom: 40px; }
    .article-content h2 { font-size: 1.25rem; font-weight: 600; margin: 36px 0 14px; color: var(--text); }
    .article-content h3 { font-size: 1.1rem; font-weight: 600; margin: 28px 0 12px; color: var(--text); }
    .article-content p { font-size: 1rem; line-height: 1.7; color: #44403c; margin-bottom: 14px; }
    .article-content ul, .article-content ol { padding-left: 24px; margin-bottom: 14px; }
    .article-content li { font-size: 1rem; line-height: 1.7; color: #44403c; margin-bottom: 6px; }
    .article-content a { color: var(--accent); text-decoration: none; }
    .article-content a:hover { color: var(--accent-hover); text-decoration: underline; }
    .article-content strong { font-weight: 600; color: var(--text); }
    .article-content hr { border: none; border-top: 1px solid var(--border); margin: 36px 0; }
    .article-content blockquote {
      border-left: 3px solid var(--accent);
      padding: 12px 20px;
      margin: 14px 0;
      background: var(--bg-subtle);
      border-radius: 0 8px 8px 0;
      color: #44403c;
    }
    .callout {
      background: var(--bg-subtle);
      border-left: 3px solid var(--accent);
      border-radius: 0 8px 8px 0;
      padding: 16px 20px;
      margin-bottom: 20px;
      font-size: 1rem;
      line-height: 1.7;
      color: #44403c;
    }
    .callout-icon { margin-right: 8px; }
    footer {
      text-align: center;
      padding: 48px 0;
      border-top: 1px solid var(--border);
      color: var(--text-secondary);
      font-size: 0.9rem;
    }
    .footer-built-by { margin-bottom: 16px; line-height: 1.6; }
    .footer-built-by a { color: var(--text); text-decoration: none; }
    .footer-built-by a:hover { color: var(--accent); }
    .footer-links { display: flex; justify-content: center; gap: 24px; flex-wrap: wrap; }
    footer a { color: var(--text-muted); text-decoration: none; transition: color 0.15s ease; }
    footer a:hover { color: var(--text); }
    @media (max-width: 600px) {
      .container { padding: 40px 16px 60px; }
      .article-title { font-size: 1.5rem; }
      .article-content h2 { font-size: 1.15rem; }
      footer { padding: 32px 0; }
      .footer-links { gap: 12px 20px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <a href="/articles" class="back">&larr; All Articles</a>
    <span class="article-badge ${article.type === 'Data Piece' ? 'badge-data' : 'badge-guide'}">${escapeHtml(article.type)}</span>
    <h1 class="article-title">${escapeHtml(article.title)}</h1>
    <p class="article-meta">${formatDate(article.created)}</p>
    <div class="article-content">
${contentHtml}
    </div>
  </div>
  <footer>
    <div class="container">
      <p class="footer-built-by">Built by <a href="https://beckyisj.com" target="_blank"><strong>Becky Isjwara</strong></a></p>
      <div class="footer-links">
        <a href="/">YouTube Producer</a>
        <a href="/articles">Articles</a>
        <a href="/privacy">Privacy Policy</a>
      </div>
    </div>
  </footer>
</body>
</html>`;
}

function listingPageHtml(articles) {
  const cards = articles.map(a => `
      <a href="/articles/${a.slug}" class="article-card">
        <div class="article-card-header">
          <span class="article-badge ${a.type === 'Data Piece' ? 'badge-data' : 'badge-guide'}">${escapeHtml(a.type)}</span>
        </div>
        <h3 class="article-card-title">${escapeHtml(a.title)}</h3>
        <p class="article-card-excerpt">${escapeHtml(a.excerpt)}</p>
        <span class="article-card-arrow">&rarr;</span>
      </a>`).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Articles — YouTube Producer</title>
  <meta name="description" content="Data-driven articles on YouTube thumbnails, titles, and channel strategy. From the team behind YouTube Producer.">
  <meta property="og:title" content="Articles — YouTube Producer">
  <meta property="og:description" content="Data-driven articles on YouTube thumbnails, titles, and channel strategy.">
  <meta property="og:url" content="${SITE_URL}/articles">
  <meta property="og:image" content="${SITE_URL}/og-image.png">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="Articles — YouTube Producer">
  <meta name="twitter:description" content="Data-driven articles on YouTube thumbnails, titles, and channel strategy.">
  <meta name="twitter:image" content="${SITE_URL}/og-image.png">
  <link rel="icon" href="/favicon.ico" sizes="32x32">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <!-- Google tag (gtag.js) -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', '${GA_ID}');
  </script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg: #fafaf9;
      --bg-surface: #ffffff;
      --bg-subtle: #f5f5f4;
      --border: #e7e5e4;
      --border-hover: #d6d3d1;
      --text: #1c1917;
      --text-secondary: #78716c;
      --text-muted: #a8a29e;
      --accent: #0d9488;
      --accent-hover: #0f766e;
      --accent-soft: rgba(13, 148, 136, 0.08);
    }
    body {
      font-family: 'Manrope', -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
    }
    .hero {
      background: linear-gradient(180deg, rgba(13, 148, 136, 0.06) 0%, transparent 100%);
    }
    .container { max-width: 1100px; margin: 0 auto; padding: 0 24px; }
    .hero-inner { padding: 60px 0 40px; }
    .back { display: inline-block; margin-bottom: 20px; font-size: 0.9rem; color: var(--text-secondary); text-decoration: none; }
    .back:hover { color: var(--accent); }
    .hero-inner h1 {
      font-size: 2.2rem;
      font-weight: 700;
      letter-spacing: -0.03em;
      margin-bottom: 8px;
    }
    .hero-inner p {
      font-size: 1.05rem;
      color: var(--text-secondary);
      line-height: 1.6;
    }
    .articles-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      padding-bottom: 80px;
    }
    .article-card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 28px;
      text-decoration: none;
      color: var(--text);
      transition: all 0.15s ease;
      display: flex;
      flex-direction: column;
      box-shadow: 0 1px 2px rgba(0,0,0,0.04);
      position: relative;
      overflow: hidden;
    }
    .article-card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 3px;
      background: linear-gradient(90deg, #0d9488, #14b8a6, #2dd4bf);
      opacity: 0;
      transition: opacity 0.15s ease;
    }
    .article-card:hover {
      border-color: var(--border-hover);
      box-shadow: 0 4px 12px rgba(0,0,0,0.06);
    }
    .article-card:hover::before { opacity: 1; }
    .article-card-header { margin-bottom: 10px; }
    .article-badge {
      display: inline-block;
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      padding: 4px 10px;
      border-radius: 100px;
    }
    .badge-data { background: rgba(124, 58, 237, 0.08); color: #7c3aed; }
    .badge-guide { background: rgba(13, 148, 136, 0.08); color: #0d9488; }
    .article-card-title {
      font-size: 1.15rem;
      font-weight: 600;
      letter-spacing: -0.02em;
      margin-bottom: 8px;
      line-height: 1.3;
    }
    .article-card-excerpt {
      font-size: 0.9rem;
      color: var(--text-secondary);
      line-height: 1.5;
      flex: 1;
    }
    .article-card-arrow {
      display: inline-block;
      margin-top: 12px;
      color: var(--text-muted);
      transition: all 0.15s ease;
      font-size: 1rem;
    }
    .article-card:hover .article-card-arrow {
      transform: translateX(4px);
      color: var(--accent);
    }
    footer {
      text-align: center;
      padding: 48px 0;
      border-top: 1px solid var(--border);
      color: var(--text-secondary);
      font-size: 0.9rem;
    }
    .footer-built-by { margin-bottom: 16px; line-height: 1.6; }
    .footer-built-by a { color: var(--text); text-decoration: none; }
    .footer-built-by a:hover { color: var(--accent); }
    .footer-links { display: flex; justify-content: center; gap: 24px; flex-wrap: wrap; }
    footer a { color: var(--text-muted); text-decoration: none; transition: color 0.15s ease; }
    footer a:hover { color: var(--text); }
    @media (max-width: 700px) {
      .articles-grid { grid-template-columns: 1fr; }
      .hero-inner { padding: 40px 0 28px; }
      .hero-inner h1 { font-size: 1.6rem; }
      .article-card { padding: 20px; }
      footer { padding: 32px 0; }
      .footer-links { gap: 12px 20px; }
    }
  </style>
</head>
<body>
  <div class="hero">
    <div class="container">
      <div class="hero-inner">
        <a href="/" class="back">&larr; YouTube Producer</a>
        <h1>Articles</h1>
        <p>Data-driven insights on YouTube thumbnails, titles, and channel strategy.</p>
      </div>
    </div>
  </div>

  <div class="container">
    <div class="articles-grid">
${cards}
    </div>
  </div>

  <footer>
    <div class="container">
      <p class="footer-built-by">Built by <a href="https://beckyisj.com" target="_blank"><strong>Becky Isjwara</strong></a></p>
      <div class="footer-links">
        <a href="/">YouTube Producer</a>
        <a href="/articles">Articles</a>
        <a href="/privacy">Privacy Policy</a>
      </div>
    </div>
  </footer>
</body>
</html>`;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching articles from Notion...');
  const articles = await fetchArticles();
  console.log(`Found ${articles.length} articles`);

  // Fetch blocks for each article
  for (const article of articles) {
    console.log(`  Fetching blocks for: ${article.title}`);
    const blocks = await fetchBlocks(article.id);
    article.blocks = blocks;
    article.excerpt = extractExcerpt(blocks);
    article.contentHtml = blocksToHtml(blocks);
  }

  // Generate individual article pages
  mkdirSync(join(ROOT, 'articles'), { recursive: true });
  for (const article of articles) {
    const html = articlePageHtml(article, article.contentHtml);
    const path = join(ROOT, 'articles', `${article.slug}.html`);
    writeFileSync(path, html);
    console.log(`  Wrote: articles/${article.slug}.html`);
  }

  // Generate listing page
  const listingHtml = listingPageHtml(articles);
  writeFileSync(join(ROOT, 'articles.html'), listingHtml);
  console.log('  Wrote: articles.html');

  console.log(`\nDone! Generated ${articles.length} article pages + listing page.`);
}

main().catch(err => { console.error(err); process.exit(1); });
