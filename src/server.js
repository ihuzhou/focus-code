import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { ProjectCatalog } from './projects.js';
import { openBrowser, viewerIdentity } from './viewer.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
].map(([route, [name, type]]) => [route, { type, content: readFileSync(new URL(`../web/${name}`, import.meta.url)) }]));

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 8192) return null;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return null; }
}

export async function serve(initial, { port = 4317, demo = false, open = true, directory, demoProjects = [] } = {}) {
  const catalog = new ProjectCatalog(initial, { demo, directory });
  for (const journal of demoProjects) catalog.register(journal.root, { journal, demo: true });
  catalog.poll(catalog.get());
  const state = viewerIdentity(catalog.directory);
  let address;
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (request.headers.host !== address.host || (request.headers.origin && request.headers.origin !== address.origin)) {
      return json(response, 403, { error: '只接受本地界面请求。' });
    }
    try {
      const url = new URL(request.url, address);
      const { pathname, searchParams } = url;
      const { method } = request;
      if (method === 'GET' && assets.has(pathname)) {
        const { type, content } = assets.get(pathname);
        response.writeHead(200, { 'Content-Type': type });
        return response.end(content);
      }
      if (method === 'POST' && (request.headers.origin !== address.origin || request.headers['content-type']?.split(';')[0] !== 'application/json')) {
        return json(response, 403, { error: '请求来源无效。' });
      }
      if (method === 'GET' && pathname === '/api/status') return json(response, 200, { app: 'focus-code', demo, state });
      if (pathname === '/api/projects') {
        if (method === 'GET') return json(response, 200, { projects: catalog.list(), selected: catalog.get()?.id ?? null });
        if (method === 'POST') {
          const body = await readJson(request);
          const added = typeof body?.path === 'string' && catalog.open(body.path);
          if (!added) return json(response, 400, { error: '请输入有效的 Git 工作树绝对路径。' });
          catalog.poll(catalog.get(added.id));
          return json(response, 201, { projects: catalog.list(), selected: added.id });
        }
      }
      const project = catalog.get(searchParams.get('project'));
      if (!project) return json(response, 404, { error: '找不到这个工程。' });
      const { journal } = project;
      if (method === 'GET' && pathname === '/api/changes') {
        const before = Number(searchParams.get('before'));
        return json(response, 200, { ...journal.list({
          branch: searchParams.get('branch'), source: searchParams.get('source'), search: searchParams.get('q')?.slice(0, 200),
          before: Number.isSafeInteger(before) && before > 0 ? before : undefined,
        }), projects: catalog.list(), demo: project.demo, scanError: project.error });
      }
      const match = /^\/api\/changes\/(\d+)(?:\/(reason|files\/(\d+)(?:\/hunks\/(\d+)\/explanation)?))?$/.exec(pathname);
      if (match) {
        const id = Number(match[1]);
        if (!Number.isSafeInteger(id)) return json(response, 404, { error: '找不到这条记录。' });
        const [, , action, position, hunk] = match;
        if (method === 'GET' && hunk === undefined) {
          const item = position !== undefined ? journal.patch(id, Number(position)) : action ? null : journal.detail(id);
          return json(response, item ? 200 : 404, item ?? { error: '找不到这条记录。' });
        }
        if (method === 'POST' && hunk !== undefined) {
          const body = await readJson(request);
          if (typeof body?.explanation !== 'string' || body.explanation.length > 1000) {
            return json(response, 400, { error: '说明最多 1000 字符。' });
          }
          const saved = journal.saveHunkNotes(id, [[Number(position), Number(hunk), body.explanation]]);
          return saved ? json(response, 200, journal.patch(id, Number(position)))
            : json(response, 404, { error: '找不到这个代码段。' });
        }
        if (method === 'POST' && action === 'reason') {
          const body = await readJson(request);
          if (typeof body?.reason !== 'string' || body.reason.length > 1000) {
            return json(response, 400, { error: '原因最多 1000 字符。' });
          }
          return journal.editReason(id, body.reason)
            ? json(response, 200, journal.detail(id))
            : json(response, 404, { error: '找不到这条记录。' });
        }
      }
      return json(response, 404, { error: '找不到此页面。' });
    } catch (error) {
      console.error(`Focus Code: ${error.message}`);
      return json(response, 500, { error: '读取变动记录失败，请查看终端。' });
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) {
    catalog.close();
    throw error;
  }
  address = new URL(`http://127.0.0.1:${server.address().port}`);
  if (!demo) {
    try { catalog.setViewer(server.address().port); }
    catch (error) {
      await new Promise(resolve => server.close(resolve));
      catalog.close();
      throw error;
    }
  }
  const timer = setInterval(() => {
    for (const project of catalog.projects.values()) catalog.poll(project);
  }, 1500);
  server.once('close', () => {
    clearInterval(timer);
    catalog.close();
  });
  console.log(`Focus Code  ${address.href}\n${demo ? '演示仓库' : initial?.root ?? '工程列表'}`);
  if (open) openBrowser(address.href);
  return { server, address };
}
