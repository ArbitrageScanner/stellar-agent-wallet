// Tiny, safe markdown renderer for assistant messages.
// Everything is HTML-escaped first; only a fixed set of tags is produced and
// links are limited to http(s). Supports: paragraphs, line breaks, **bold**,
// *italic*, `code`, ```fences```, [links](https://…), bare URLs, lists,
// headings, blockquotes and horizontal rules. Unclosed fences render as code,
// which keeps partially streamed text stable.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHTML = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

const link = (href, text) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;

export function inline(src) {
  const codes = [];
  let s = String(src).replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHTML(s);
  // [text](https://url)
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => link(u, t));
  // bare URLs (not already inside an attribute or link text)
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, u) => {
    const m = /[.,;:!?]+$/.exec(u);
    const tail = m ? m[0] : '';
    const url = tail ? u.slice(0, -tail.length) : u;
    return `${pre}${link(url, url)}${tail}`;
  });
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w])__([^_\n]+?)__(?!\w)/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHTML(codes[Number(i)])}</code>`);
  return s;
}

const RE_FENCE = /^\s*```/;
const RE_LIST = /^\s*(?:[-*+•]|\d{1,3}[.)])\s+/;
const RE_OL = /^\s*\d{1,3}[.)]\s+/;
const RE_HEAD = /^(#{1,6})\s+(.*)$/;
const RE_QUOTE = /^\s*>\s?/;
const RE_HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

const isBlockStart = (l) => RE_FENCE.test(l) || RE_LIST.test(l) || RE_HEAD.test(l) || RE_QUOTE.test(l) || RE_HR.test(l);

export function renderMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (RE_FENCE.test(line)) {
      const lang = line.replace(/^\s*```/, '').trim();
      const body = [];
      i++;
      while (i < lines.length && !RE_FENCE.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or EOF)
      const cls = lang ? ` data-lang="${escapeHTML(lang)}"` : '';
      out.push(`<pre${cls}><code>${escapeHTML(body.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    if (RE_HR.test(line)) { out.push('<hr>'); i++; continue; }
    const hm = RE_HEAD.exec(line);
    if (hm) {
      const lvl = Math.min(6, hm[1].length + 2);
      out.push(`<h${lvl}>${inline(hm[2])}</h${lvl}>`);
      i++;
      continue;
    }
    if (RE_QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) body.push(lines[i++].replace(RE_QUOTE, ''));
      out.push(`<blockquote>${renderMarkdown(body.join('\n'))}</blockquote>`);
      continue;
    }
    if (RE_LIST.test(line)) {
      const ordered = RE_OL.test(line);
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        if (RE_LIST.test(l)) { items.push(l.replace(RE_LIST, '')); i++; continue; }
        if (l.trim() && /^\s{2,}/.test(l) && items.length) { items[items.length - 1] += '\n' + l.trim(); i++; continue; }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const startNum = ordered ? parseInt(line.trim(), 10) : 1;
      const start = ordered && startNum > 1 ? ` start="${startNum}"` : '';
      out.push(`<${tag}${start}>${items.map((t) => `<li>${inline(t).replace(/\n/g, '<br>')}</li>`).join('')}</${tag}>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !(para.length && isBlockStart(lines[i]))) para.push(lines[i++]);
    out.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }
  return out.join('');
}
