const $ = id => document.getElementById(id);
const labels = { codex: 'Codex', claude: 'Claude Code', pi: 'Pi', opencode: 'OpenCode', gemini: 'Gemini CLI', trae: 'TRAE', 'trae-cli': 'TRAE CLI', workspace: '工作区', mixed: '来源不明' };
const codes = { added: 'A', modified: 'M', deleted: 'D' };
const statuses = { added: '新增', modified: '修改', deleted: '删除' };
const limitations = { binary: '二进制文件，已记录变动。', large: '文件超过 256 KiB，已记录变动。', complex: '差异计算超时，已记录文件变动。' };
const fullTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' });
const shortTime = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayFormat = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
let changes = [];
let selected = 0;
let following = true;
let detail;
let file;
let hunks;
let patchMessage;
let view = 0;
let listRequest = 0;
let detailRequest = 0;
let fileRequest = 0;
let paginated = false;
let pageHasMore = false;
let debounce;
let listKey;
let diffLimit = 1500;
let project = '';
let branch = '';
let branchListKey;
let projectsLoaded = false;
let projectListKey;
let projectsRequest = 0;
let hunkTarget;

function projectRoute(path, id = project) {
  const url = new URL(path, location.origin);
  url.searchParams.set('project', id);
  return `${url.pathname}${url.search}`;
}

function updateProjectOptions(projects, preferred) {
  const picker = $('project');
  const key = JSON.stringify(projects);
  if (key === projectListKey && picker.value === preferred) return;
  if (key !== projectListKey) {
    projectListKey = key;
    const counts = new Map();
    for (const item of projects) counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
    picker.replaceChildren(...projects.map(item => {
      const label = item.demo ? `${item.name}（演示）` : counts.get(item.name) > 1 ? item.root : item.name;
      const option = element('option', '', label);
      option.value = item.id;
      option.title = item.root ?? '';
      return option;
    }));
    picker.disabled = !projects.length;
    if (picker.disabled) picker.append(element('option', '', '选择工程'));
  }
  picker.value = preferred;
  picker.title = picker.selectedOptions[0]?.title ?? '';
}

function renderProjects(data, preferred = data.selected) {
  const selectedId = data.projects.some(item => item.id === preferred) ? preferred : data.selected ?? '';
  updateProjectOptions(data.projects, selectedId);
  if (!projectsLoaded || project !== selectedId) switchProject(selectedId);
  else if (!project) renderEmptyProjects();
  projectsLoaded = true;
}

function renderEmptyProjects() {
  $('connection').textContent = '未选择工程';
  $('signal').classList.remove('live');
  $('alert').hidden = true;
  placeholder('还没有工程', '已接入的代理记录到修改后，工程会自动出现在列表，也可以手动添加。');
}

function branchName(value) {
  return value === 'HEAD' ? '分离 HEAD' : value;
}

function updateBranchOptions(current, branches) {
  const picker = $('branch');
  const key = JSON.stringify([current, branches]);
  if (key !== branchListKey) {
    branchListKey = key;
    picker.replaceChildren(element('option', '', '所有分支'), ...branches.map(value => {
      const label = branchName(value);
      const option = element('option', '', value === current ? `${label}（当前）` : label);
      option.value = value;
      return option;
    }));
    picker.options[0].value = '';
    picker.disabled = branches.length === 0;
  }
  const selectedBranch = branches.includes(branch) ? branch : '';
  if (picker.value !== selectedBranch) picker.value = selectedBranch;
  picker.title = selectedBranch ? branchName(selectedBranch) : current ? `当前工作树分支 ${branchName(current)}` : '';
}

function resetTimeline() {
  view++;
  detailRequest++;
  fileRequest++;
  selected = 0;
  detail = file = hunks = null;
  changes = [];
  following = true;
  paginated = false;
  clearTimeout(debounce);
  $('reason-form').hidden = true;
  $('hunk-dialog').close();
  $('count').textContent = '0';
  $('more').hidden = true;
  renderList();
}

function updateAddress() {
  const url = new URL(location.href);
  if (project) url.searchParams.set('project', project);
  else url.searchParams.delete('project');
  if (branch) url.searchParams.set('branch', branch);
  else url.searchParams.delete('branch');
  history.replaceState(null, '', url);
}

function switchProject(id) {
  const picker = $('project');
  picker.title = picker.selectedOptions[0]?.title ?? '';
  const params = new URLSearchParams(location.search);
  project = id;
  branch = id && params.get('project') === id ? params.get('branch') ?? '' : '';
  resetTimeline();
  $('root').textContent = '';
  $('demo').hidden = true;
  updateBranchOptions(null, []);
  $('search').disabled = $('source').disabled = !id;
  updateAddress();
  if (id) {
    placeholder('正在读取变动', '');
    void refresh();
  } else {
    renderEmptyProjects();
  }
}

function switchBranch(value) {
  branch = value;
  resetTimeline();
  updateAddress();
  placeholder('正在读取变动', '');
  void refresh();
}

async function loadProjects() {
  const request = ++projectsRequest;
  try {
    const data = await api('/api/projects');
    if (request !== projectsRequest || project) return;
    renderProjects(data, new URLSearchParams(location.search).get('project') ?? data.selected);
  } catch (error) {
    if (request !== projectsRequest || project) return;
    renderConnection(null, error);
    placeholder('无法读取工程列表', '检查本地服务是否仍在运行，然后重试。');
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

function stats(change) {
  const node = element('span', 'stats');
  node.append(element('span', 'plus', `+${change.added}`), ' ', element('span', 'minus', `−${change.removed}`));
  return node;
}

function fileSummary(path, count) {
  return count === 1 ? path : `${path} 等 ${count} 个文件`;
}

function title(change) {
  return change.reason?.split('\n')[0].replace(/[。！]$/, '') || fileSummary(change.first_path, change.file_count);
}

function dayLabel(time) {
  const date = new Date(time);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return '今天';
  today.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return '昨天';
  return date.getFullYear() === today.getFullYear() ? dayFormat.format(date) : date.toLocaleDateString('zh-CN');
}

function renderList() {
  const key = JSON.stringify([selected, changes]);
  if (key === listKey) return;
  listKey = key;
  const list = $('timeline-list');
  const oldTop = list.scrollTop;
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.id : null;
  const content = document.createDocumentFragment();
  let day;
  let restoreFocus;
  for (const change of changes) {
    const date = new Date(change.time).toDateString();
    if (day !== date) {
      day = date;
      content.append(element('h3', 'day', dayLabel(change.time)));
    }
    const button = element('button', 'event');
    button.type = 'button';
    button.dataset.id = change.id;
    button.setAttribute('aria-current', String(change.id === selected));
    const time = element('time', '', shortTime.format(change.time));
    time.dateTime = new Date(change.time).toISOString();
    time.title = fullTime.format(change.time);
    const line = element('span', 'event-line');
    line.append(element('span', `source ${change.source}`, labels[change.source]), time);
    const name = element('span', 'event-title', title(change));
    name.title = title(change);
    const foot = element('span', 'event-foot');
    foot.append(`${change.file_count} 个文件`, stats(change));
    button.append(line, name, foot);
    button.addEventListener('click', () => {
      following = false;
      if (change.id !== selected) selectChange(change.id);
    });
    if (button.dataset.id === focused) restoreFocus = button;
    content.append(button);
  }
  if (!changes.length) content.append(element('p', 'no-results', '没有匹配的变动。'));
  list.replaceChildren(content);
  if (restoreFocus) restoreFocus.focus({ preventScroll: true });
  list.scrollTop = oldTop;
}

function renderConnection(data, error) {
  const message = error ? '连接中断，正在重试。' : data.scanError ? '仓库扫描暂时失败，请检查运行 Focus Code 的终端。' : '';
  $('connection').textContent = error ? '连接中断' : data.scanError ? '扫描异常' : '本地监测';
  $('signal').classList.toggle('live', !message);
  $('alert').textContent = message;
  $('alert').hidden = !message;
  if (error) return;
  const repo = data.repository;
  $('demo').hidden = !data.demo;
  $('count').textContent = data.stats.changes;
  $('root').textContent = data.demo ? '' : repo.root;
  document.title = `${repo.name} · Focus Code`;
}

async function refresh({ more = false } = {}) {
  if (!project) return loadProjects();
  const currentView = view;
  const request = more ? null : ++listRequest;
  const parameters = new URLSearchParams({ q: $('search').value, source: $('source').value });
  if (branch) parameters.set('branch', branch);
  if (more && changes.length) parameters.set('before', changes.at(-1).id);
  if (more) $('more').disabled = true;
  try {
    const data = await api(projectRoute(`/api/changes?${parameters}`));
    if (currentView !== view || (!more && request !== listRequest)) return;
    updateProjectOptions(data.projects, project);
    const { branch: current, branches } = data.repository;
    if (branch && !branches.includes(branch)) {
      switchBranch('');
      return;
    }
    updateBranchOptions(current, branches);
    renderConnection(data);
    if (more) {
      paginated = true;
      pageHasMore = data.hasMore;
      const byId = new Map([...changes, ...data.changes].map(change => [change.id, change]));
      changes = [...byId.values()].sort((a, b) => b.id - a.id);
    } else if (paginated && data.changes.length) {
      changes = [...data.changes, ...changes.filter(change => change.id < data.changes.at(-1).id)];
    } else {
      changes = data.changes;
    }
    $('more').hidden = !(paginated ? pageHasMore : data.hasMore);
    const choice = changes.find(change => change.id === selected);
    const editing = !$('reason-form').hidden || $('hunk-dialog').open;
    if (!choice || (!more && following && !editing && selected !== changes[0]?.id)) {
      selectChange(changes[0]?.id, { emptyRepo: data.stats.changes === 0 });
    } else if (!editing && (!detail || detail.reason !== choice.reason || detail.reason_origin !== choice.reason_origin || detail.notes_version !== choice.notes_version)) {
      void loadDetail(choice.id, file?.position);
    }
    renderList();
  } catch (error) {
    if (currentView === view && (!request || request === listRequest)) {
      renderConnection(null, error);
      if (!detail) placeholder('无法读取变动记录', '检查本地服务是否仍在运行。');
    }
  } finally {
    if (more) $('more').disabled = false;
  }
}

function placeholder(titleText, text) {
  $('placeholder-title').textContent = titleText;
  $('placeholder-text').textContent = text;
  $('placeholder').hidden = false;
  $('detail').hidden = true;
}

function selectChange(id, { emptyRepo } = {}) {
  selected = id ?? 0;
  detail = null;
  file = null;
  $('reason-form').hidden = true;
  renderList();
  if (selected) {
    placeholder('正在读取变动', '');
    void loadDetail(selected);
  } else if (emptyRepo && branch) {
    placeholder('这个分支还没有变动记录', '可以切换分支查看其他记录。');
  } else if (emptyRepo) {
    placeholder('还没有代码变动', '保存一次修改后，新的 diff 会出现在这里。');
  } else {
    placeholder('没有匹配的变动', '可以清除搜索词或切换来源。');
  }
}

async function loadDetail(id, position) {
  const request = ++detailRequest;
  try {
    const data = await api(projectRoute(`/api/changes/${id}`));
    if (selected !== data.id || request !== detailRequest) return;
    detail = data;
    $('placeholder').hidden = true;
    $('detail').hidden = false;
    $('detail-source').textContent = labels[data.source];
    $('detail-source').className = `source ${data.source}`;
    $('detail-tool').textContent = data.tool ?? '';
    $('detail-tool').hidden = !data.tool;
    $('detail-time').dateTime = new Date(data.time).toISOString();
    $('detail-time').textContent = fullTime.format(data.time);
    $('detail-title').textContent = fileSummary(data.files[0].path, data.file_count);
    $('detail-branch').textContent = branchName(data.branch);
    $('detail-count').textContent = `${data.file_count} 个文件`;
    $('detail-stats').replaceChildren(stats(data));
    $('file-count').textContent = data.file_count;
    renderReason();
    void selectFile(data.files.find(item => item.position === position) ?? data.files[0], { keepScroll: position !== undefined });
  } catch (error) {
    if (selected === id && request === detailRequest) placeholder('无法读取变动', error.message);
  }
}

function renderReason() {
  const editor = !$('reason-form').hidden;
  $('reason-origin').textContent = detail.reason_origin === 'agent' ? '代理提交' : detail.reason_origin === 'user' ? '手动填写' : '';
  $('reason').textContent = detail.reason ?? '尚未记录原因。';
  $('reason').hidden = editor;
  $('reason').classList.toggle('missing', !detail.reason);
  $('edit-reason').textContent = detail.reason ? '编辑' : '补写';
  $('edit-reason').hidden = editor;
}

function renderFiles() {
  const focused = $('files').contains(document.activeElement);
  let focus;
  const nodes = detail.files.map(item => {
    const button = element('button', 'file-button');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(item.position === file.position));
    const code = element('span', `file-status ${item.status}`, codes[item.status]);
    code.setAttribute('aria-label', statuses[item.status]);
    button.append(code, element('span', 'file-name', item.path), stats(item));
    button.addEventListener('click', () => void selectFile(item));
    if (focused && item.position === file.position) focus = button;
    return button;
  });
  $('files').replaceChildren(...nodes);
  focus?.focus({ preventScroll: true });
}

async function selectFile(item, { keepScroll = false } = {}) {
  const request = ++fileRequest;
  const id = detail.id;
  file = item;
  renderFiles();
  $('diff-path').textContent = item.path;
  if (!keepScroll) {
    diffLimit = 1500;
    hunks = null;
    patchMessage = '正在加载 diff…';
    renderDiff();
    $('diff-view').scrollTo(0, 0);
  }
  try {
    const data = await api(projectRoute(`/api/changes/${id}/files/${item.position}`));
    if (selected !== id || request !== fileRequest) return;
    hunks = data;
    patchMessage = limitations[item.limitation] ?? (item.old_mode && item.new_mode && item.old_mode !== item.new_mode
      ? `文件模式由 ${item.old_mode} 变为 ${item.new_mode}。` : '没有逐行文本差异。');
  } catch (error) {
    if (selected !== id || request !== fileRequest) return;
    patchMessage = error.message;
  }
  renderDiff();
}

function describeHunk(hunk) {
  const added = hunk.lines.filter(line => line.startsWith('+'));
  const removed = hunk.lines.filter(line => line.startsWith('-'));
  const describe = lines => {
    const sample = lines.map(line => line.slice(1).trim()).find(Boolean);
    if (!sample) return `${lines.length} 行空白`;
    const snippet = `「${sample.length > 85 ? `${sample.slice(0, 85)}…` : sample}」`;
    return lines.length === 1 ? snippet : `${snippet}等 ${lines.length} 行`;
  };
  if (added.length && removed.length) {
    if (added.length === removed.length && added.every((line, index) => line.slice(1).trim() === removed[index].slice(1).trim())) {
      return `调整了 ${added.length} 行的空白或换行。`;
    }
    return `将${describe(removed)}替换为${describe(added)}。`;
  }
  if (added.length) return `新增${describe(added)}。`;
  if (removed.length) return `删除${describe(removed)}。`;
  return '调整了文件末尾的换行。';
}

function hunkNote(hunk, index) {
  const note = element('div', `hunk-note${hunk.explanation ? '' : ' inferred'}`);
  const info = element('div', 'hunk-note-text');
  const source = hunk.explanation_origin === 'agent' ? '代理说明' : hunk.explanation_origin === 'user' ? '手动填写' : '差异摘要';
  info.append(element('span', 'hunk-label', source), element('p', '', hunk.explanation ?? describeHunk(hunk)));
  const button = element('button', 'button subtle', hunk.explanation ? '编辑说明' : '补写原因');
  button.type = 'button';
  button.setAttribute('aria-label', `${button.textContent}（代码段 ${index + 1}）`);
  button.addEventListener('click', () => {
    following = false;
    hunkTarget = { project, id: detail.id, position: file.position, index };
    $('hunk-location').textContent = `${file.path} · 代码段 ${index + 1}`;
    $('hunk-explanation').value = hunk.explanation ?? '';
    $('hunk-error').textContent = '';
    $('hunk-dialog').showModal();
    $('hunk-explanation').focus();
  });
  note.append(info, button);
  return note;
}

function renderDiff() {
  const area = $('diff-view');
  $('context').disabled = !hunks?.length;
  if (!hunks?.length) {
    area.replaceChildren(element('p', 'diff-message', patchMessage));
    return;
  }
  const patch = element('div', 'patch');
  if (file.old_mode && file.new_mode && file.old_mode !== file.new_mode) {
    patch.append(element('div', 'diff-row hunk', `mode ${file.old_mode} → ${file.new_mode}`));
  }
  let count = 0;
  const context = $('context').checked;
  for (const [index, hunk] of hunks.entries()) {
    if (count >= diffLimit) break;
    patch.append(element('div', 'diff-row hunk', `@@ −${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`), hunkNote(hunk, index));
    const lines = element('div', 'hunk-lines');
    const code = element('div', 'hunk-code');
    lines.append(code);
    patch.append(lines);
    let before = hunk.oldStart;
    let after = hunk.newStart;
    for (const line of hunk.lines) {
      const sign = line[0];
      if (sign === ' ' && !context) {
        before++;
        after++;
        continue;
      }
      if (++count > diffLimit) break;
      if (sign === '\\') {
        code.append(element('div', 'diff-row note-line', line));
        continue;
      }
      const row = element('div', `diff-row ${sign === '+' ? 'add' : sign === '-' ? 'remove' : ''}`);
      row.append(element('span', 'line-number', sign === '+' ? '' : before++), element('span', 'line-number', sign === '-' ? '' : after++),
        element('span', 'operator', sign), element('code', 'line-code', line.slice(1)));
      code.append(row);
    }
  }
  area.replaceChildren(patch);
  if (count >= diffLimit) {
    const controls = element('div', 'diff-message');
    const more = element('button', 'button', '继续显示 diff');
    more.type = 'button';
    more.addEventListener('click', () => { diffLimit += 1500; renderDiff(); });
    controls.append(more);
    area.append(controls);
  }
}

function applyFilters() {
  view++;
  paginated = false;
  following = true;
  void refresh();
}

const jsonOptions = data => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

$('project').addEventListener('change', event => switchProject(event.target.value));
$('branch').addEventListener('change', event => switchBranch(event.target.value));
$('add-project').addEventListener('click', () => {
  $('project-error').textContent = '';
  $('project-dialog').showModal();
  $('project-path').focus();
});
$('cancel-project').addEventListener('click', () => $('project-dialog').close());
$('project-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  try {
    const data = await api('/api/projects', jsonOptions({ path: $('project-path').value }));
    $('project-dialog').close();
    $('project-path').value = '';
    projectsRequest++;
    renderProjects(data);
  } catch (error) {
    $('project-error').textContent = error.message;
  } finally {
    if (submit) submit.disabled = false;
  }
});
$('cancel-hunk').addEventListener('click', () => $('hunk-dialog').close());
$('hunk-form').addEventListener('submit', async event => {
  event.preventDefault();
  const target = hunkTarget;
  const { id, position, index } = target;
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  try {
    const data = await api(projectRoute(`/api/changes/${id}/files/${position}/hunks/${index}/explanation`, target.project),
      jsonOptions({ explanation: $('hunk-explanation').value }));
    if (target === hunkTarget) $('hunk-dialog').close();
    if (project === target.project && selected === id && file?.position === position) {
      hunks = data;
      renderDiff();
      $('diff-view').querySelectorAll('.hunk-note button')[index]?.focus({ preventScroll: true });
      await refresh();
    }
  } catch (error) {
    if (target === hunkTarget) $('hunk-error').textContent = error.message;
  } finally {
    if (submit) submit.disabled = false;
  }
});

$('search').addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = setTimeout(applyFilters, 160);
});
$('source').addEventListener('change', applyFilters);
$('refresh').addEventListener('click', () => void refresh());
$('more').addEventListener('click', () => void refresh({ more: true }));
$('context').addEventListener('change', renderDiff);
$('edit-reason').addEventListener('click', () => {
  $('reason-input').value = detail.reason ?? '';
  $('reason-error').textContent = '';
  $('reason-form').hidden = false;
  renderReason();
  $('reason-input').focus();
});
$('cancel-reason').addEventListener('click', () => {
  $('reason-form').hidden = true;
  renderReason();
  $('edit-reason').focus();
});
$('reason-form').addEventListener('submit', async event => {
  event.preventDefault();
  const id = detail.id;
  const origin = project;
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  try {
    const result = await api(projectRoute(`/api/changes/${id}/reason`, origin), jsonOptions({ reason: $('reason-input').value }));
    if (project === origin && selected === id) {
      detail = result;
      $('reason-form').hidden = true;
      renderReason();
      $('edit-reason').focus();
    }
    await refresh();
  } catch (error) {
    if (project === origin && selected === id) $('reason-error').textContent = error.message;
  } finally {
    if (submit) submit.disabled = false;
  }
});
window.addEventListener('keydown', event => {
  if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || event.target.matches?.('input, textarea, select, [contenteditable]')) return;
  event.preventDefault();
  $('search').focus();
});
void refresh();
setInterval(() => void refresh(), 1800);
