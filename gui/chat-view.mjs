/** Render a small Markdown subset using text nodes, never HTML from the model. */
export function renderChatMessage(element, text) {
  const doc = element.ownerDocument;
  const fragment = doc.createDocumentFragment();
  const make = (tag, value) => {
    const node = doc.createElement(tag);
    if (value !== undefined) node.textContent = value;
    return node;
  };
  const inline = (parent, value) => {
    const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>]+)/g;
    let start = 0;
    for (const match of value.matchAll(pattern)) {
      parent.append(doc.createTextNode(value.slice(start, match.index)));
      const token = match[0];
      if (token.startsWith('`')) parent.append(make('code', token.slice(1, -1)));
      else if (token.startsWith('**')) parent.append(make('strong', token.slice(2, -2)));
      else {
        const markdown = token.match(/^\[([^\]]+)\]\((.+)\)$/);
        const href = markdown ? markdown[2] : token.replace(/[.,;!?]+$/, '');
        let url;
        try {
          url = new URL(href);
        } catch {
          url = null;
        }
        if (url && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) {
          const link = make('a', markdown ? markdown[1] : href);
          link.href = url.href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          parent.append(link);
          if (!markdown && href.length < token.length) parent.append(doc.createTextNode(token.slice(href.length)));
        } else parent.append(doc.createTextNode(token));
      }
      start = match.index + token.length;
    }
    parent.append(doc.createTextNode(value.slice(start)));
  };
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  let paragraph = [];
  let list = null;
  let code = null;
  const flush = () => {
    if (!paragraph.length) return;
    const p = make('p');
    inline(p, paragraph.join('\n'));
    fragment.append(p);
    paragraph = [];
  };
  for (const line of lines) {
    const fence = line.match(/^\s*```([^`]*)$/);
    if (fence) {
      flush();
      list = null;
      if (code) {
        fragment.append(code.pre);
        code = null;
      } else {
        const pre = make('pre');
        const content = make('code');
        pre.append(content);
        pre.className = 'chat-code-block';
        const language = fence[1].trim();
        if (language) pre.setAttribute('aria-label', `${language} code`);
        code = { pre, content, lines: [] };
      }
      continue;
    }
    if (code) {
      code.lines.push(line);
      code.content.textContent = code.lines.join('\n');
      continue;
    }
    if (!line.trim()) {
      flush();
      list = null;
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      flush();
      list = null;
      const h = make('h3');
      inline(h, heading[1]);
      fragment.append(h);
      continue;
    }
    const item = line.match(/^\s*(?:([-*])\s+|\d+[.)]\s+)(.+)$/);
    if (item) {
      flush();
      const tag = item[1] ? 'ul' : 'ol';
      if (!list || list.tagName.toLowerCase() !== tag) {
        list = make(tag);
        fragment.append(list);
      }
      const li = make('li');
      inline(li, item[2]);
      list.append(li);
      continue;
    }
    list = null;
    paragraph.push(line);
  }
  flush();
  if (code) fragment.append(code.pre);
  element.replaceChildren(fragment);
}
