import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { CurrentChanges } from './current.js';
import { ProjectCatalog } from './projects.js';
import { trackingModes } from './tracking.js';
import { translate } from '../web/i18n.js';
import { openBrowser, viewerIdentity, viewerPorts } from './viewer.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/review-state.js', ['review-state.js', 'text/javascript; charset=utf-8']],
  ['/time-range.js', ['time-range.js', 'text/javascript; charset=utf-8']],
  ['/logo.svg', ['logo.svg', 'image/svg+xml']],
  ['/diff-summary.js', ['diff-summary.js', 'text/javascript; charset=utf-8']],
  ['/i18n.js', ['i18n.js', 'text/javascript; charset=utf-8']],
  ['/theme.js', ['theme.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
].map(([route, [name, type]]) => [route, { type, content: readFileSync(new URL(`../web/${name}`, import.meta.url)) }]));

function timestampParameter(params, key) {
  const value = params.get(key);
  if (value === null) return undefined;
  const time = Number(value);
  return /^-?\d+$/.test(value) && Number.isSafeInteger(time) ? time : NaN;
}

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

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const failed = error => {
      server.off('listening', ready);
      reject(error);
    };
    const ready = () => {
      server.off('error', failed);
      resolve();
    };
    server.once('error', failed);
    server.once('listening', ready);
    server.listen(port, '127.0.0.1');
  });
}

export async function serve(initial, { port, demo = false, open = true, directory, demoProjects = [] } = {}) {
  const catalog = new ProjectCatalog(initial, { demo, directory });
  for (const journal of demoProjects) catalog.register(journal.root, { journal, demo: true });
  await catalog.poll(catalog.get());
  const state = viewerIdentity(catalog.directory);
  let address;
  const server = createServer(async (request, response) => {
    const language = request.headers['accept-language'] === 'en' ? 'en' : 'zh-CN';
    const failure = (status, key) => json(response, status, { error: translate(language, key) });
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (request.headers.host !== address.host || (request.headers.origin && request.headers.origin !== address.origin)) {
      return failure(403, 'localRequest');
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
        return failure(403, 'invalidOrigin');
      }
      if (method === 'GET' && pathname === '/api/status') return json(response, 200, { app: 'focus-code', demo, state });
      if (pathname === '/api/projects') {
        if (method === 'GET') {
          const selected = catalog.get();
          await catalog.discover(selected);
          return json(response, 200, { projects: catalog.list(), selected: selected?.id ?? null });
        }
        if (method === 'POST') {
          const body = await readJson(request);
          const added = typeof body?.path === 'string' && catalog.open(body.path);
          if (!added) return failure(400, 'invalidWorktree');
          const project = catalog.get(added.id);
          await Promise.all([catalog.discover(project), catalog.poll(project)]);
          return json(response, 201, { projects: catalog.list(), selected: added.id });
        }
      }
      if (pathname === '/api/tracking') {
        const id = searchParams.get('project');
        const project = id ? catalog.get(id) : demo ? catalog.initial : null;
        if (id && !project) return failure(404, 'missingProject');
        const settingsStore = project?.demo ? project.journal.tracking : catalog.tracking;
        if (method === 'GET') {
          return json(response, 200, { ...settingsStore.get(project?.root), editable: true, demo: Boolean(project?.demo) });
        }
        if (method === 'POST') {
          const body = await readJson(request);
          const { defaultEnabled, mode } = body ?? {};
          const invalidDefault = defaultEnabled !== undefined && typeof defaultEnabled !== 'boolean';
          const invalidOverride = mode !== undefined && (!project || !trackingModes.includes(mode));
          if ((defaultEnabled === undefined && mode === undefined) || invalidDefault || invalidOverride) {
            return failure(400, 'invalidTracking');
          }
          const affected = defaultEnabled !== undefined
            ? [...catalog.projects.values()].filter(entry => Boolean(entry.demo) === Boolean(project?.demo))
            : [project];
          // A scan that started under the old setting cannot establish the new baseline.
          await Promise.all(affected.map(entry => entry.polling));
          const settings = settingsStore.update({ defaultEnabled, mode, root: project?.root });
          await Promise.all(affected.map(entry => catalog.poll(entry)));
          return json(response, 200, { ...settings, editable: true, demo: Boolean(project?.demo) });
        }
      }
      const project = catalog.get(searchParams.get('project'));
      if (!project) return failure(404, 'missingProject');
      const { journal } = project;
      if (method === 'GET' && pathname === '/api/timeline') {
        const from = timestampParameter(searchParams, 'from');
        const until = timestampParameter(searchParams, 'until');
        if (Number.isNaN(from) || Number.isNaN(until) || (from !== undefined && until !== undefined && from >= until)) {
          return failure(400, 'invalidTimeRange');
        }
        const current = project.current ??= new CurrentChanges(journal);
        // Discovery updates the dropdown on the next refresh; it need not delay the timeline.
        void catalog.discover(project)?.catch(error => console.error(`Focus Code (${project.root}): ${error.message}`));
        const snapshot = await current.refresh();
        if (snapshot.tracking.enabled && snapshot.head !== journal.getMeta('head')) {
          const initializing = !journal.getMeta('initialized');
          const scan = catalog.poll(project);
          // Live diffs do not need a full snapshot when the project is first opened.
          if (!initializing) await scan;
        }
        const limit = Number(searchParams.get('limit'));
        const branch = searchParams.get('scope') === 'current' ? snapshot.branch : searchParams.get('branch');
        return json(response, 200, {
          ...current.timeline({ branch, from, until, source: searchParams.get('source'), search: searchParams.get('q')?.slice(0, 200),
            limit: Number.isSafeInteger(limit) && limit > 0 && limit < Number.MAX_SAFE_INTEGER ? limit : undefined }, snapshot),
          projects: catalog.list(), demo: project.demo, scanError: project.error,
        });
      }
      if (method === 'GET' && (pathname === '/api/current' || pathname.startsWith('/api/current/'))) {
        const current = project.current ??= new CurrentChanges(journal);
        if (pathname === '/api/current') {
          const [{ tracking, branch }] = await Promise.all([current.refresh(), catalog.discover(project)]);
          return json(response, 200, {
            ...current.list({ branch: searchParams.get('branch'), source: searchParams.get('source'), search: searchParams.get('q')?.slice(0, 200) }),
            repository: journal.repository(branch), projects: catalog.list(), demo: project.demo, scanError: project.error, tracking,
          });
        }
        const match = /^\/api\/current\/([a-f\d]{64})(\/files\/0)?$/.exec(pathname);
        if (!match || !journal.tracking.get(project.root).enabled) return failure(404, 'missingChange');
        const item = match[2] ? current.patch(match[1]) : current.detail(match[1], language);
        return item ? json(response, 200, item) : failure(404, 'missingChange');
      }
      if (method === 'GET' && pathname === '/api/changes') {
        await catalog.discover(project);
        const before = Number(searchParams.get('before'));
        return json(response, 200, { ...journal.list({
          branch: searchParams.get('branch'), source: searchParams.get('source'), search: searchParams.get('q')?.slice(0, 200),
          before: Number.isSafeInteger(before) && before > 0 ? before : undefined,
        }), projects: catalog.list(), demo: project.demo, scanError: project.error, tracking: journal.tracking.get(project.root) });
      }
      const match = /^\/api\/changes\/(\d+)(?:\/(reason|files\/(\d+)(?:\/hunks\/(\d+)\/explanation)?))?$/.exec(pathname);
      if (match) {
        const id = Number(match[1]);
        if (!Number.isSafeInteger(id)) return failure(404, 'missingChange');
        const [, , action, position, hunk] = match;
        const detail = () => journal.detail(id, { includeReasonEvidence: true, language, timeline: searchParams.get('timeline') === '1' });
        if (method === 'GET' && hunk === undefined) {
          const item = position !== undefined ? journal.patch(id, Number(position)) : action ? null : detail();
          return item ? json(response, 200, item) : failure(404, 'missingChange');
        }
        if (method === 'POST' && hunk !== undefined) {
          const body = await readJson(request);
          if (typeof body?.explanation !== 'string' || body.explanation.length > 1000) {
            return failure(400, 'explanationLimit');
          }
          const saved = journal.saveHunkNotes(id, [[Number(position), Number(hunk), body.explanation]]);
          return saved ? json(response, 200, journal.patch(id, Number(position)))
            : failure(404, 'missingSection');
        }
        if (method === 'POST' && action === 'reason') {
          const body = await readJson(request);
          if (typeof body?.reason !== 'string' || body.reason.length > 1000) {
            return failure(400, 'reasonLimit');
          }
          return journal.editReason(id, body.reason)
            ? json(response, 200, detail())
            : failure(404, 'missingChange');
        }
      }
      return failure(404, 'missingPage');
    } catch (error) {
      console.error(`Focus Code: ${error.message}`);
      return failure(500, 'apiFailure');
    }
  });
  const candidates = port === undefined ? [...viewerPorts, 0] : [port];
  try {
    for (const candidate of candidates) {
      try {
        await listen(server, candidate);
        break;
      } catch (error) {
        if (error.code !== 'EADDRINUSE' || candidate === 0) throw error;
        if (port !== undefined) throw new Error(`端口 ${port} 已被占用。可以换一个 --port，或省略它由 Focus Code 选择可用端口。`);
      }
    }
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
