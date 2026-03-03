#!/usr/bin/env node

/**
 * Fetches articles from Notion and generates static HTML pages.
 * No dependencies — uses native fetch (Node 22).
 *
 * Usage: node scripts/build-articles.mjs
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
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

// ── Video data for thumbnails ────────────────────────────────────────

const VIDEO_DATA_PATH = join(homedir(), 'Cursor', 'zz YT Strategy', 'AliAbdaal', 'thumbnail-analysis', 'video-data.json');
const videoData = existsSync(VIDEO_DATA_PATH) ? JSON.parse(readFileSync(VIDEO_DATA_PATH, 'utf8')) : [];
const videoById = Object.fromEntries(videoData.map(v => [v.videoId, v]));

// Track which video IDs need thumbnails downloaded
const thumbnailsNeeded = new Set();

async function downloadThumbnail(videoId) {
  const imgDir = join(ROOT, 'articles', 'img');
  const imgPath = join(imgDir, `${videoId}.jpg`);
  if (existsSync(imgPath)) return;
  try {
    const url = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(imgPath, buf);
    console.log(`    Downloaded thumbnail: ${videoId}`);
  } catch (e) {
    console.warn(`    Failed to download thumbnail ${videoId}: ${e.message}`);
  }
}

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
    // Convert leftover markdown *italic* to <em>
    text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
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

// ── Pattern detection helpers ────────────────────────────────────────

function getPlainText(richTextArray) {
  return (richTextArray || []).map(rt => rt.plain_text).join('');
}

function extractYouTubeId(richTextArray) {
  for (const rt of (richTextArray || [])) {
    if (rt.href) {
      const m = rt.href.match(/youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)/);
      if (m) return m[1];
    }
  }
  return null;
}

function isVideoReferenceItem(richTextArray) {
  const plain = getPlainText(richTextArray);
  return !!extractYouTubeId(richTextArray) && /views/i.test(plain);
}

// Match "Label: XX%" or "Label XX%" as the primary structure
const BAR_PATTERN = /^(.+?)[\s:–—]+(\d+[–-]?\d*)\s*%/;

function isPercentageItem(richTextArray) {
  const plain = getPlainText(richTextArray).replace(/<[^>]+>/g, '');
  return BAR_PATTERN.test(plain);
}

function formatViews(count) {
  if (count >= 1_000_000) return (count / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (count >= 1_000) return (count / 1_000).toFixed(0) + 'K';
  return String(count);
}

function renderThumbnailGrid(blockItems) {
  const cards = blockItems.map(richText => {
    const videoId = extractYouTubeId(richText);
    if (!videoId) return `<li>${richTextToHtml(richText)}</li>`;

    thumbnailsNeeded.add(videoId);
    const video = videoById[videoId];
    const channelName = video?.channelName || '';
    const views = video ? formatViews(video.viewCount) : '';
    const plain = getPlainText(richText);
    // Extract description after the views mention, strip leading punctuation
    const descMatch = plain.match(/views\.?\s*(.*)/i);
    let desc = (descMatch?.[1] || '').replace(/^[):\s.–—-]+/, '').trim();
    // Fallback: show video title if no description extracted
    if (!desc && video?.title) desc = video.title;

    const altText = video?.title ? `${channelName} — ${video.title}` : channelName;
    return `<a class="thumb-card" href="https://www.youtube.com/watch?v=${videoId}" target="_blank" rel="noopener">
      <div class="thumb-img-wrap">
        <img src="img/${videoId}.jpg" alt="${escapeHtml(altText)}" loading="lazy">
        ${views ? `<span class="views-badge">${views} views</span>` : ''}
      </div>
      <div class="thumb-meta">
        ${channelName ? `<span class="channel-tag">${escapeHtml(channelName)}</span>` : ''}
        ${desc ? `<p class="thumb-desc">${escapeHtml(desc)}</p>` : ''}
      </div>
    </a>`;
  });

  return `<div class="thumb-grid reveal">${cards.join('\n')}</div>`;
}

function shortenLabel(label) {
  // Truncate parenthetical lists: "Everything else (blue, red, ...)" → "Everything else"
  return label.replace(/\s*\([^)]{20,}\)/, '').trim();
}

function renderBarChart(blockItems) {
  const bars = blockItems.map(richText => {
    const plain = getPlainText(richText);
    const m = plain.match(BAR_PATTERN);
    if (!m) return `<li>${richTextToHtml(richText)}</li>`;
    const label = shortenLabel(m[1].replace(/\*+/g, '').trim());
    const pct = m[2].replace(/[–-]/, '-');
    const widthNum = parseInt(pct);
    return `<div class="bar-row">
      <span class="bar-label">${escapeHtml(label)}</span>
      <div class="bar-track"><div class="bar-fill" data-width="${widthNum}"></div></div>
      <span class="bar-pct">${escapeHtml(pct)}%</span>
    </div>`;
  });

  return `<div class="bar-chart reveal">${bars.join('\n')}</div>`;
}

// ── Blocks → HTML (with list grouping + visual detection) ────────────

function blocksToHtml(blocks) {
  const parts = [];
  let i = 0;

  while (i < blocks.length) {
    const block = blocks[i];
    const type = block.type;

    // Group consecutive bulleted list items
    if (type === 'bulleted_list_item') {
      const richTexts = [];
      while (i < blocks.length && blocks[i].type === 'bulleted_list_item') {
        richTexts.push(blocks[i].bulleted_list_item.rich_text);
        i++;
      }

      // Detect video reference lists (majority have YouTube URLs + "views")
      const videoCount = richTexts.filter(rt => isVideoReferenceItem(rt)).length;
      if (videoCount >= 2 && videoCount / richTexts.length >= 0.5) {
        parts.push(renderThumbnailGrid(richTexts));
        continue;
      }

      // Detect percentage bar chart lists (majority match "Label: XX%")
      const pctCount = richTexts.filter(rt => isPercentageItem(rt)).length;
      if (pctCount >= 3 && pctCount / richTexts.length >= 0.6) {
        parts.push(renderBarChart(richTexts));
        continue;
      }

      // Default: regular <ul>
      const items = richTexts.map(rt => `<li>${richTextToHtml(rt)}</li>`);
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
        parts.push(`<h2 class="reveal">${richTextToHtml(block.heading_2.rich_text)}</h2>`);
        break;
      case 'heading_3':
        parts.push(`<h3 class="reveal">${richTextToHtml(block.heading_3.rich_text)}</h3>`);
        break;
      case 'callout': {
        const emoji = block.callout.icon?.emoji || '';
        const text = richTextToHtml(block.callout.rich_text);
        parts.push(`<div class="callout reveal">${emoji ? `<span class="callout-icon">${emoji}</span>` : ''}${text}</div>`);
        break;
      }
      case 'divider':
        parts.push('<hr>');
        break;
      case 'quote':
        parts.push(`<blockquote class="reveal">${richTextToHtml(block.quote.rich_text)}</blockquote>`);
        break;
      default:
        break;
    }
    i++;
  }

  return parts.join('\n');
}

// ── Post-process: link unlinked video mentions ──────────────────────

// Build a view-count lookup: "15.3M" → videoId (use highest-viewed match)
const viewsToVideo = {};
for (const v of videoData) {
  const key = formatViews(v.viewCount);
  // Keep the one with highest views if multiple match the same formatted string
  if (!viewsToVideo[key] || v.viewCount > viewsToVideo[key].viewCount) {
    viewsToVideo[key] = v;
  }
}

function cleanCockyAsides(html) {
  return html
    // Remove parenthetical asides: (trust me on this one), (seriously), (Seriously.)
    .replace(/\s*\(trust me on this one\.?\)\s*/gi, ' ')
    .replace(/\s*\(seriously\.?\)\s*/gi, ' ')
    .replace(/\s*\(seriously,\s*it happens\.?\)\s*/gi, ' ')
    // Remove trailing " (seriously)" at end of sentences before closing tags
    .replace(/\s*\(seriously\)\s*(?=<)/gi, ' ')
    // Clean double spaces left behind
    .replace(/  +/g, ' ')
    // Clean space before period/comma
    .replace(/ ([.,])/g, '$1');
}

function linkInlineVideoMentions(html) {
  // Match "(X.XM views)" not already inside an <a> tag
  return html.replace(/(?<!<a[^>]*>[^<]*)\((\d+(?:\.\d+)?[MK]) views\)/g, (match, viewStr) => {
    const video = viewsToVideo[viewStr];
    if (!video) return match;
    return `(<a href="https://www.youtube.com/watch?v=${video.videoId}" target="_blank" rel="noopener">${viewStr} views</a>)`;
  });
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
  <meta name="robots" content="index, follow, max-image-preview:large">
  <link rel="canonical" href="${SITE_URL}/articles/${article.slug}">
  <meta property="og:title" content="${escapeHtml(article.title)} — YouTube Producer">
  <meta property="og:description" content="${escapeHtml(article.excerpt)}">
  <meta property="og:url" content="${SITE_URL}/articles/${article.slug}">
  <meta property="og:image" content="${SITE_URL}/og-image.png">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="YouTube Producer">
  <meta property="article:published_time" content="${article.created}">
  <meta property="article:author" content="https://beckyisj.com">
  <meta property="article:section" content="${escapeHtml(article.type)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:site" content="@beckyisj">
  <meta name="twitter:creator" content="@beckyisj">
  <meta name="twitter:title" content="${escapeHtml(article.title)} — YouTube Producer">
  <meta name="twitter:description" content="${escapeHtml(article.excerpt)}">
  <meta name="twitter:image" content="${SITE_URL}/og-image.png">
  <link rel="icon" href="/favicon.ico" sizes="32x32">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Article",
        "headline": "${escapeHtml(article.title)}",
        "description": "${escapeHtml(article.excerpt)}",
        "image": "${SITE_URL}/og-image.png",
        "datePublished": "${article.created}",
        "author": {
          "@type": "Person",
          "name": "Becky Isjwara",
          "url": "https://beckyisj.com"
        },
        "publisher": {
          "@type": "Organization",
          "name": "YouTube Producer",
          "url": "${SITE_URL}",
          "logo": { "@type": "ImageObject", "url": "${SITE_URL}/favicon.svg" }
        },
        "mainEntityOfPage": "${SITE_URL}/articles/${article.slug}"
      },
      {
        "@type": "BreadcrumbList",
        "itemListElement": [
          { "@type": "ListItem", "position": 1, "name": "Home", "item": "${SITE_URL}" },
          { "@type": "ListItem", "position": 2, "name": "Articles", "item": "${SITE_URL}/articles" },
          { "@type": "ListItem", "position": 3, "name": "${escapeHtml(article.title)}" }
        ]
      }
    ]
  }
  </script>
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
    .container { max-width: 680px; margin: 0 auto; padding: 60px 24px 40px; }
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
    .footer-socials { display: flex; justify-content: center; align-items: center; gap: 20px; margin-bottom: 16px; }
    .footer-socials a { color: var(--text-muted); text-decoration: none; transition: color 0.2s; display: flex; align-items: center; }
    .footer-socials a:hover { color: var(--text); }
    .footer-cta { color: var(--text-secondary); font-weight: 500; }
    .footer-cta:hover { color: var(--accent); }
    .footer-tip { color: var(--text-muted); display: inline-flex; align-items: center; gap: 5px; }
    .footer-tip:hover { color: var(--text); }

    /* Thumbnail grid */
    .thumb-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 14px;
      margin: 14px 0 20px;
    }
    .thumb-card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      text-decoration: none;
      color: var(--text);
      transition: transform 0.2s, box-shadow 0.2s;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    }
    .thumb-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.08);
    }
    .thumb-img-wrap {
      position: relative;
      aspect-ratio: 16/9;
      overflow: hidden;
      background: #f0efed;
    }
    .thumb-img-wrap img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .views-badge {
      position: absolute;
      bottom: 6px;
      right: 6px;
      background: rgba(0,0,0,0.82);
      color: #fff;
      font-size: 0.65rem;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 5px;
      backdrop-filter: blur(4px);
    }
    .thumb-meta { padding: 8px 10px 10px; }
    .channel-tag {
      font-size: 0.65rem;
      font-weight: 700;
      color: var(--accent);
      display: block;
      margin-bottom: 2px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .thumb-desc {
      font-size: 0.8rem;
      color: var(--text-secondary);
      line-height: 1.4;
      margin: 0 !important;
    }

    /* Bar charts */
    .bar-chart { margin: 14px 0 20px; }
    .bar-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 6px;
    }
    .bar-label {
      font-size: 0.85rem;
      font-weight: 500;
      color: var(--text);
      width: 180px;
      flex-shrink: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .bar-track {
      flex: 1;
      height: 8px;
      background: #e7e5e4;
      border-radius: 4px;
      overflow: hidden;
    }
    .bar-fill {
      height: 100%;
      width: 0;
      background: linear-gradient(90deg, #0d9488, #14b8a6);
      border-radius: 4px;
      transition: width 0.8s cubic-bezier(0.22, 1, 0.36, 1);
    }
    .bar-pct {
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--text-secondary);
      width: 56px;
      text-align: right;
      flex-shrink: 0;
      white-space: nowrap;
    }

    /* Scroll reveal */
    .reveal {
      opacity: 0;
      transform: translateY(20px);
      transition: opacity 0.5s ease, transform 0.5s ease;
    }
    .reveal.visible {
      opacity: 1;
      transform: none;
    }

    @media (max-width: 600px) {
      .thumb-grid { grid-template-columns: 1fr 1fr; gap: 10px; }
      .bar-label { width: 120px; font-size: 0.8rem; }
      .bar-pct { width: 40px; font-size: 0.8rem; }
    }
    @media (max-width: 400px) {
      .thumb-grid { grid-template-columns: 1fr; }
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
    <article>
    <span class="article-badge ${article.type === 'Data Piece' ? 'badge-data' : 'badge-guide'}">${escapeHtml(article.type)}</span>
    <h1 class="article-title">${escapeHtml(article.title)}</h1>
    <p class="article-meta"><time datetime="${article.created}">${formatDate(article.created)}</time></p>
    <div class="article-content">
${contentHtml}
    </div>
    </article>
  </div>
  <footer>
    <div class="container">
      <p class="footer-built-by">Built by <a href="https://beckyisj.com" target="_blank"><strong>Becky Isjwara</strong></a></p>
      <div class="footer-socials">
        <a href="https://www.youtube.com/@beckyisj" target="_blank" aria-label="YouTube"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg></a>
        <a href="https://beckyisj.substack.com" target="_blank" aria-label="Substack"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M22.539 8.242H1.46V5.406h21.08v2.836zM1.46 10.812V24L12 18.11 22.54 24V10.812H1.46zM22.54 0H1.46v2.836h21.08V0z"/></svg></a>
        <a href="https://www.linkedin.com/in/beckyisj/" target="_blank" aria-label="LinkedIn"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg></a>
        <a href="https://www.instagram.com/beckyisj/" target="_blank" aria-label="Instagram"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z"/></svg></a>
        <a href="https://github.com/beckyisj" target="_blank" aria-label="GitHub"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg></a>
      </div>
      <div class="footer-links">
        <a href="https://go.beckyisj.com/workwithme" target="_blank" class="footer-cta">Work with me</a>
        <a href="https://go.beckyisj.com/30min" target="_blank" class="footer-cta">Book a call</a>
        <a href="https://checkout.beckyisj.com/b/fZu28rbL49uNasD1tReAg00" target="_blank" class="footer-tip"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></svg>Tip jar</a>
        <a href="/articles">Articles</a>
        <a href="/privacy">Privacy Policy</a>
      </div>
    </div>
  </footer>
  <script>
    // Scroll reveal
    const obs = new IntersectionObserver((entries) => {
      entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('visible'); obs.unobserve(e.target); } });
    }, { threshold: 0.15 });
    document.querySelectorAll('.reveal').forEach(el => obs.observe(el));

    // Animate bar fills when visible
    const barObs = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          e.target.querySelectorAll('.bar-fill').forEach(bar => {
            bar.style.width = bar.dataset.width + '%';
          });
          barObs.unobserve(e.target);
        }
      });
    }, { threshold: 0.2 });
    document.querySelectorAll('.bar-chart').forEach(el => barObs.observe(el));
  </script>
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
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="${SITE_URL}/articles">
  <meta property="og:title" content="Articles — YouTube Producer">
  <meta property="og:description" content="Data-driven articles on YouTube thumbnails, titles, and channel strategy.">
  <meta property="og:url" content="${SITE_URL}/articles">
  <meta property="og:image" content="${SITE_URL}/og-image.png">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="YouTube Producer">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:site" content="@beckyisj">
  <meta name="twitter:creator" content="@beckyisj">
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
    .footer-socials { display: flex; justify-content: center; align-items: center; gap: 20px; margin-bottom: 16px; }
    .footer-socials a { color: var(--text-muted); text-decoration: none; transition: color 0.2s; display: flex; align-items: center; }
    .footer-socials a:hover { color: var(--text); }
    .footer-links { display: flex; justify-content: center; gap: 24px; flex-wrap: wrap; }
    footer a { color: var(--text-muted); text-decoration: none; transition: color 0.15s ease; }
    footer a:hover { color: var(--text); }
    .footer-cta { color: var(--text-secondary); font-weight: 500; }
    .footer-cta:hover { color: var(--accent); }
    .footer-tip { color: var(--text-muted); display: inline-flex; align-items: center; gap: 5px; }
    .footer-tip:hover { color: var(--text); }
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
      <div class="footer-socials">
        <a href="https://www.youtube.com/@beckyisj" target="_blank" aria-label="YouTube"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg></a>
        <a href="https://beckyisj.substack.com" target="_blank" aria-label="Substack"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M22.539 8.242H1.46V5.406h21.08v2.836zM1.46 10.812V24L12 18.11 22.54 24V10.812H1.46zM22.54 0H1.46v2.836h21.08V0z"/></svg></a>
        <a href="https://www.linkedin.com/in/beckyisj/" target="_blank" aria-label="LinkedIn"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg></a>
        <a href="https://www.instagram.com/beckyisj/" target="_blank" aria-label="Instagram"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z"/></svg></a>
        <a href="https://github.com/beckyisj" target="_blank" aria-label="GitHub"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg></a>
      </div>
      <div class="footer-links">
        <a href="https://go.beckyisj.com/workwithme" target="_blank" class="footer-cta">Work with me</a>
        <a href="https://go.beckyisj.com/30min" target="_blank" class="footer-cta">Book a call</a>
        <a href="https://checkout.beckyisj.com/b/fZu28rbL49uNasD1tReAg00" target="_blank" class="footer-tip"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></svg>Tip jar</a>
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
    article.excerpt = extractExcerpt(blocks)
      .replace(/\s*\(trust me on this one\.?\)/gi, '')
      .replace(/\s*\(seriously\.?\)/gi, '');
    article.contentHtml = cleanCockyAsides(linkInlineVideoMentions(blocksToHtml(blocks)));
  }

  // Create directories
  mkdirSync(join(ROOT, 'articles'), { recursive: true });
  mkdirSync(join(ROOT, 'articles', 'img'), { recursive: true });

  // Download needed thumbnails
  if (thumbnailsNeeded.size > 0) {
    console.log(`\nDownloading ${thumbnailsNeeded.size} thumbnails...`);
    await Promise.all([...thumbnailsNeeded].map(id => downloadThumbnail(id)));
  }

  // Generate individual article pages
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

  // Generate sitemap.xml
  const today = new Date().toISOString().split('T')[0];
  const sitemapUrls = [
    `  <url><loc>${SITE_URL}/</loc><changefreq>monthly</changefreq><priority>1.0</priority></url>`,
    `  <url><loc>${SITE_URL}/articles</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`,
    ...articles.map(a =>
      `  <url><loc>${SITE_URL}/articles/${a.slug}</loc><lastmod>${a.created}</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>`
    ),
  ];
  const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapUrls.join('\n')}
</urlset>`;
  writeFileSync(join(ROOT, 'sitemap.xml'), sitemapXml);
  console.log('  Wrote: sitemap.xml');

  // Generate robots.txt
  const robotsTxt = `User-agent: *
Allow: /

Sitemap: ${SITE_URL}/sitemap.xml`;
  writeFileSync(join(ROOT, 'robots.txt'), robotsTxt);
  console.log('  Wrote: robots.txt');

  console.log(`\nDone! Generated ${articles.length} article pages + listing page + sitemap + robots.txt.`);
}

main().catch(err => { console.error(err); process.exit(1); });
