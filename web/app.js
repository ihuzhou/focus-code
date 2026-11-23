import { describeHunk } from './diff-summary.js';
import { translate } from './i18n.js';
import { timeBounds } from './time-range.js';

const $ = id => document.getElementById(id);
const labels = { codex: 'Codex', claude: 'Claude Code', pi: 'Pi', opencode: 'OpenCode', gemini: 'Gemini CLI', trae: 'TRAE', 'trae-cli': 'TRAE CLI' };
const codes = { added: 'A', modified: 'M', deleted: 'D' };
let language = readPreference('focus-code-language') === 'en' ? 'en' : 'zh-CN';
let dates = dateFormatters();
const t = (key, ...values) => translate(language, key, ...values);
const sourceName = source => labels[source] ?? t(source);
const fileLimitation = value => value ? t(value) : '';
let changes = [];
let selected = 0;
let following = true;
let detail;
let file;
let hunks;
let patchMessage;
const changeApi = id => `${typeof id === 'string' ? '/api/current' : '/api/changes'}/${id}`;
let historyLimit = 40;
let view = 0;
let listRequest = 0;
let detailRequest = 0;
let pendingDetail = 0;
let fileRequest = 0;
let debounce;
let listKey;
let diffLimit = 1500;
let project = '';
const followCurrent = ':current'; // Not a valid Git ref name.
let branch = followCurrent;
let branchListKey;
let projectsLoaded = false;
let projectListKey;
let projectsRequest = 0;
let hunkTarget;
let trackingTarget;
let trackingInitial;
let trackingRequest = 0;
let timeFilter = { period: 'all' };

function readPreference(key) {
  try { return localStorage.getItem(key); }
  catch { return null; }
}

function savePreference(key, value) {
  try { localStorage.setItem(key, value); }
  catch { /* Preferences still apply for the current page. */ }
}

function dateFormatters() {
  return {
    full: new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'medium' }),
    short: new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
    day: new Intl.DateTimeFormat(language, { month: 'long', day: 'numeric', weekday: 'short' }),
    range: new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric' }),
  };
}

function translateInterface() {
  document.documentElement.lang = language;
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const [attribute, key] of [['aria-label', 'aria'], ['placeholder', 'placeholder'], ['title', 'title']]) {
    for (const node of document.querySelectorAll(`[data-i18n-${key}]`)) {
      node.setAttribute(attribute, t(node.getAttribute(`data-i18n-${key}`)));
    }
  }
  document.title = `Focus Code · ${t('timeline')}`;
  renderTimeFilter();
  markOptions('language', language);
  markOptions('theme-choice', document.documentElement.dataset.theme ?? 'auto');
}

function projectRoute(path, id = project) {
  const url = new URL(path, location.origin);
  url.searchParams.set('project', id);
  return `${url.pathname}${url.search}`;
}

function updateProjectOptions(projects, preferred) {
  const picker = $('project');
  const key = JSON.stringify([language, projects]);
  if (key === projectListKey && picker.value === preferred) return;
  if (key !== projectListKey) {
    projectListKey = key;
    const counts = new Map();
    for (const item of projects) counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
    picker.replaceChildren(...projects.map(item => {
      const label = item.demo ? t('demoProject', item.name) : counts.get(item.name) > 1 ? item.root : item.name;
      const option = element('option', '', label);
      option.value = item.id;
      option.title = item.root ?? '';
      return option;
    }));
    picker.disabled = !projects.length;
    if (picker.disabled) picker.append(element('option', '', t('chooseProject')));
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
  $('connection').textContent = t('unselected');
  $('signal').classList.remove('live', 'paused');
  $('alert').hidden = true;
  placeholder(t('noProjects'), t('discoverProjects'));
}

function branchName(value) {
  return value === 'HEAD' ? t('detachedHead') : value;
}

function updateBranchOptions(current, branches) {
  const picker = $('branch');
  const key = JSON.stringify([language, current, branches]);
  if (key !== branchListKey) {
    branchListKey = key;
    const follow = element('option', '', current ? t('currentBranch', branchName(current)) : t('followCurrentBranch'));
    follow.value = followCurrent;
    const all = element('option', '', t('allBranches'));
    all.value = '';
    picker.replaceChildren(follow, all, ...branches.map(value => {
      const option = element('option', '', branchName(value));
      option.value = value;
      return option;
    }));
    picker.disabled = !current && branches.length === 0;
  }
  picker.value = branch;
  const pinned = branch && branch !== followCurrent;
  picker.title = pinned ? branchName(branch) : current ? t('branchTitle', branchName(current)) : '';
}

function resetTimeline() {
  view++;
  detailRequest++;
  fileRequest++;
  selected = 0;
  detail = file = hunks = null;
  changes = [];
  following = true;
  historyLimit = 40;
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
  if (project && branch !== followCurrent) url.searchParams.set('branch', branch);
  else url.searchParams.delete('branch');
  url.searchParams.delete('view');
  history.replaceState(null, '', url);
}

function switchProject(id) {
  const picker = $('project');
  picker.title = picker.selectedOptions[0]?.title ?? '';
  const params = new URLSearchParams(location.search);
  project = id;
  branch = id && params.get('project') === id ? params.get('branch') ?? followCurrent : followCurrent;
  resetTimeline();
  $('root').textContent = '';
  $('demo').hidden = true;
  updateBranchOptions(null, []);
  $('search').disabled = $('source').disabled = !id;
  updateAddress();
  if (id) {
    placeholder(t('loadingChanges'), '');
    void refresh();
  } else {
    renderEmptyProjects();
  }
}

function switchBranch(value) {
  branch = value;
  resetTimeline();
  updateAddress();
  placeholder(t('loadingChanges'), '');
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
    placeholder(t('projectListError'), t('serverHint'));
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function api(path, options) {
  const headers = new Headers(options?.headers);
  headers.set('Accept-Language', language);
  const response = await fetch(path, { ...options, headers });
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
  return count === 1 ? path : t('fileSummary', path, count);
}

function title(change) {
  return change.reason?.split('\n')[0].replace(/[。！]$/, '') || fileSummary(change.first_path, change.file_count);
}

function dayLabel(time) {
  const date = new Date(time);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return t('today');
  today.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return t('yesterday');
  return date.getFullYear() === today.getFullYear() ? dates.day.format(date) : date.toLocaleDateString(language);
}

function renderList() {
  const key = JSON.stringify([language, selected, changes]);
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
    const time = element('time', '', dates.short.format(change.time));
    time.dateTime = new Date(change.time).toISOString();
    time.title = dates.full.format(change.time);
    const line = element('span', 'event-line');
    const badges = element('span', 'event-badges');
    badges.append(element('span', `source ${change.source}`, sourceName(change.source)));
    if (change.uncommitted) {
      const tag = element('span', 'head-tag', 'HEAD');
      tag.title = t('uncommittedChange');
      tag.setAttribute('aria-label', t('uncommittedChange'));
      badges.append(tag);
    }
    line.append(badges, time);
    const name = element('span', 'event-title', title(change));
    name.title = title(change);
    const foot = element('span', 'event-foot');
    foot.append(t('filesCount', change.file_count), stats(change));
    button.append(line, name, foot);
    button.addEventListener('click', () => {
      following = false;
      if (change.id !== selected) selectChange(change.id);
    });
    if (button.dataset.id === focused) restoreFocus = button;
    content.append(button);
  }
  if (!changes.length) content.append(element('p', 'no-results', t('noResults')));
  list.replaceChildren(content);
  if (restoreFocus) restoreFocus.focus({ preventScroll: true });
  list.scrollTop = oldTop;
}

function renderConnection(data, error) {
  const message = error ? t('reconnecting') : data.scanError ? t('scanError') : '';
  const paused = !error && data.tracking?.enabled === false;
  $('connection').textContent = t(error ? 'disconnected' : data.scanError ? 'scanFailed' : paused ? 'paused' : 'localTracking');
  $('signal').classList.toggle('live', !message && !paused);
  $('signal').classList.toggle('paused', paused);
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
  const request = ++listRequest;
  if (more) historyLimit += 40;
  const parameters = new URLSearchParams({ q: $('search').value, source: $('source').value, limit: historyLimit });
  if (branch === followCurrent) parameters.set('scope', 'current');
  else if (branch) parameters.set('branch', branch);
  for (const [key, value] of Object.entries(timeBounds(timeFilter))) parameters.set(key, value);
  if (more) $('more').disabled = true;
  try {
    const data = await api(projectRoute(`/api/timeline?${parameters}`));
    if (currentView !== view || request !== listRequest) return;
    updateProjectOptions(data.projects, project);
    const { branch: current, branches } = data.repository;
    if (branch && branch !== followCurrent && branch !== current && !branches.includes(branch)) {
      switchBranch(followCurrent);
      return;
    }
    updateBranchOptions(current, branches);
    renderConnection(data);
    const previous = changes.find(change => change.id === selected);
    changes = data.changes;
    $('more').hidden = !data.hasMore;
    const choice = changes.find(change => change.id === selected);
    const committed = !choice && previous?.uncommitted && changes.find(change => change.id === previous.history_id);
    const editing = !$('reason-form').hidden || $('hunk-dialog').open;
    if (committed) {
      selectChange(committed.id);
    } else if (!choice || (!more && following && !editing && selected !== changes[0]?.id)) {
      selectChange(changes[0]?.id, { emptyRepo: data.stats.changes === 0, paused: data.tracking?.enabled === false });
    } else if (!editing && (!pendingDetail || pendingDetail !== detailRequest) &&
      (!detail || detail.reason !== choice.reason || detail.reason_origin !== choice.reason_origin ||
      detail.notes_version !== choice.notes_version || detail.diff_revision !== choice.diff_revision || detail.history_id !== choice.history_id ||
      detail.file_count !== choice.file_count || detail.source !== choice.source || detail.tool !== choice.tool || detail.branch !== choice.branch)) {
      void loadDetail(choice.id, file?.position);
    }
    renderList();
  } catch (error) {
    if (currentView === view && request === listRequest) {
      renderConnection(null, error);
      if (!detail) placeholder(t('historyError'), t('serverHint'));
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

function selectChange(id, { emptyRepo, paused } = {}) {
  selected = id ?? 0;
  detail = null;
  file = null;
  $('reason-form').hidden = true;
  renderList();
  if (selected) {
    placeholder(t('loadingChanges'), '');
    void loadDetail(selected);
  } else if (emptyRepo && paused) {
    placeholder(t('paused'), t('resumeHint'));
  } else if (emptyRepo && timeFilter.period !== 'all') {
    placeholder(t('noChangesInRange'), t('changeRangeHint'));
  } else if (emptyRepo && branch) {
    placeholder(t('noBranchHistory'), t('otherBranchHint'));
  } else if (emptyRepo) {
    placeholder(t('noHistory'), t('saveFileHint'));
  } else {
    placeholder(t('noResults'), t('clearFilters'));
  }
}

async function loadDetail(id, position) {
  const request = pendingDetail = ++detailRequest;
  try {
    const data = await api(projectRoute(`${changeApi(id)}?timeline=1`));
    if (selected !== data.id || request !== detailRequest) return;
    detail = data;
    $('placeholder').hidden = true;
    $('detail').hidden = false;
    $('detail-source').textContent = sourceName(data.source);
    $('detail-source').className = `source ${data.source}`;
    $('detail-tool').textContent = data.tool ?? '';
    $('detail-tool').hidden = !data.tool;
    $('detail-time').dateTime = new Date(data.time).toISOString();
    $('detail-time').textContent = dates.full.format(data.time);
    $('detail-title').textContent = fileSummary(data.files[0].path, data.file_count);
    $('detail-branch').textContent = branchName(data.branch);
    $('detail-count').textContent = t('filesCount', data.file_count);
    $('detail-stats').replaceChildren(stats(data));
    $('file-count').textContent = data.file_count;
    renderReason();
    void selectFile(data.files.find(item => item.position === position) ?? data.files[0], { keepScroll: position !== undefined });
  } catch (error) {
    if (selected === id && request === detailRequest) placeholder(t('detailError'), error.message);
  } finally {
    if (request === pendingDetail) pendingDetail = 0;
  }
}

function changeOverview(change) {
  const { notes, position, sample } = change.reason_evidence ?? {};
  if (notes?.length) {
    return {
      label: t('sectionNotes'),
      text: notes.map(note => note.trim().length > 200 ? `${note.trim().slice(0, 200)}…` : note.trim()).join('\n'),
    };
  }
  const file = change.files.find(item => item.position === position) ?? change.files[0];
  const action = file ? `${t(file.status)} ${file.path}` : t('workspaceUpdated');
  const remaining = change.file_count - 1;
  const files = remaining > 0 ? t('otherFiles', action, remaining) : `${action}${language === 'en' ? '.' : '。'}`;
  const modeChanged = file?.old_mode && file?.new_mode && file.old_mode !== file.new_mode;
  const details = sample ?? (modeChanged ? t('modeChanged', file.old_mode, file.new_mode) : fileLimitation(file?.limitation));
  const totals = change.added || change.removed ? t('lineTotals', change.added, change.removed) : '';
  return { label: t('overview'), text: [files, details, totals].filter(Boolean).join(' ') };
}

function renderReason() {
  const editor = !$('reason-form').hidden;
  const summary = !detail.reason ? changeOverview(detail) : null;
  $('reason-origin').textContent = summary?.label ?? t(detail.reason_origin === 'agent' ? 'sourceAgent' : 'sourceUser');
  $('reason').textContent = detail.reason || summary.text;
  $('reason').hidden = editor;
  $('reason').classList.toggle('missing', Boolean(summary));
  $('edit-reason').textContent = t(detail.reason ? 'edit' : 'addReason');
  $('edit-reason').hidden = editor || (detail.uncommitted && !detail.history_id);
}

function renderFiles() {
  const focused = $('files').contains(document.activeElement);
  let focus;
  const nodes = detail.files.map(item => {
    const button = element('button', 'file-button');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(item.position === file.position));
    const code = element('span', `file-status ${item.status}`, codes[item.status]);
    code.setAttribute('aria-label', t(item.status));
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
    patchMessage = t('loadDiff');
    renderDiff();
    $('diff-view').scrollTo(0, 0);
  }
  try {
    const data = await api(projectRoute(`${changeApi(id)}/files/${item.position}`));
    if (selected !== id || request !== fileRequest) return;
    hunks = data;
    patchMessage = fileLimitation(item.limitation) || (item.old_mode && item.new_mode && item.old_mode !== item.new_mode
      ? t('modeChanged', item.old_mode, item.new_mode) : t('noDiff'));
  } catch (error) {
    if (selected !== id || request !== fileRequest) return;
    patchMessage = error.message;
  }
  renderDiff();
}

function hunkNote(hunk, index) {
  const note = element('div', `hunk-note${hunk.explanation ? '' : ' inferred'}`);
  const info = element('div', 'hunk-note-text');
  const source = t(hunk.explanation_origin === 'agent' ? 'agentExplanation' : hunk.explanation_origin === 'user' ? 'sourceUser' : 'diffSummary');
  info.append(element('span', 'hunk-label', source), element('p', '', hunk.explanation ?? describeHunk(hunk, language)));
  note.append(info);
  if (detail.uncommitted) return note;
  const button = element('button', 'button subtle', t(hunk.explanation ? 'editExplanation' : 'addExplanation'));
  button.type = 'button';
  button.setAttribute('aria-label', t('sectionLabel', button.textContent, index + 1));
  button.addEventListener('click', () => {
    following = false;
    hunkTarget = { project, id: detail.id, position: file.position, index };
    $('hunk-location').textContent = t('sectionLocation', file.path, index + 1);
    $('hunk-explanation').value = hunk.explanation ?? '';
    $('hunk-error').textContent = '';
    $('hunk-dialog').showModal();
    $('hunk-explanation').focus();
  });
  note.append(button);
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
    const more = element('button', 'button', t('displayMoreDiff'));
    more.type = 'button';
    more.addEventListener('click', () => { diffLimit += 1500; renderDiff(); });
    controls.append(more);
    area.append(controls);
  }
}

function applyFilters() {
  view++;
  historyLimit = 40;
  following = true;
  void refresh();
}

const jsonOptions = data => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

function markOptions(attribute, value) {
  for (const button of document.querySelectorAll(`button[data-${attribute}]`)) {
    button.setAttribute('aria-pressed', String(button.getAttribute(`data-${attribute}`) === value));
  }
}

function closeDropdown(dropdown, restoreFocus = false) {
  dropdown.open = false;
  if (restoreFocus) dropdown.querySelector('summary').focus();
}

function renderTimeFilter() {
  const { period, start, end } = timeFilter;
  const label = period === 'custom' ? t('customRange') : t(period === 'all' ? 'allTime' : period);
  const summary = $('date-dropdown').querySelector('summary');
  const bounds = timeBounds(timeFilter);
  $('date-filter-label').textContent = period === 'custom'
    ? dates.range.formatRange(new Date(bounds.from), new Date(bounds.until - 1)) : label;
  const description = period === 'custom' ? `${label}: ${start} – ${end}` : `${t('timeFilter')}: ${label}`;
  summary.title = description;
  summary.setAttribute('aria-label', description);
  summary.classList.toggle('active', period !== 'all');
  markOptions('period', period);
}

function setTimeFilter(filter) {
  timeFilter = filter;
  $('date-error').textContent = '';
  renderTimeFilter();
  closeDropdown($('date-dropdown'), true);
  applyFilters();
}

for (const button of document.querySelectorAll('button[data-period]')) {
  button.addEventListener('click', () => setTimeFilter({ period: button.dataset.period }));
}
$('date-form').addEventListener('input', () => { $('date-error').textContent = ''; });
$('date-form').addEventListener('submit', event => {
  event.preventDefault();
  const filter = { period: 'custom', start: $('date-start').value, end: $('date-end').value };
  if (timeBounds(filter)) setTimeFilter(filter);
  else $('date-error').textContent = t('invalidTimeRange');
});

for (const button of document.querySelectorAll('button[data-language]')) {
  button.addEventListener('click', () => {
    language = button.dataset.language;
    savePreference('focus-code-language', language);
    dates = dateFormatters();
    translateInterface();
    closeDropdown(button.closest('details'), true);
    renderList();
    if (selected) void loadDetail(selected, file?.position);
    void refresh();
  });
}
for (const button of document.querySelectorAll('button[data-theme-choice]')) {
  button.addEventListener('click', () => {
    const theme = button.dataset.themeChoice;
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    savePreference('focus-code-theme', theme);
    markOptions('theme-choice', theme);
    closeDropdown(button.closest('details'), true);
  });
}
document.addEventListener('click', event => {
  for (const dropdown of document.querySelectorAll('.dropdown[open]')) {
    if (!dropdown.contains(event.target)) closeDropdown(dropdown);
  }
});

$('tracking-settings').addEventListener('click', async () => {
  const request = ++trackingRequest;
  trackingTarget = project;
  trackingInitial = null;
  $('tracking-fields').disabled = true;
  $('save-tracking').disabled = true;
  $('tracking-project-field').hidden = !project;
  $('demo-tracking-help').hidden = true;
  $('tracking-project-label').textContent = $('project').selectedOptions[0]?.textContent ?? t('currentProject');
  $('tracking-error').textContent = '';
  $('tracking-dialog').showModal();
  try {
    const settings = await api(projectRoute('/api/tracking', trackingTarget));
    if (!$('tracking-dialog').open || request !== trackingRequest) return;
    trackingInitial = settings;
    $('tracking-default').value = settings.defaultEnabled ? 'on' : 'off';
    $('tracking-project').value = settings.mode;
    $('demo-tracking-help').hidden = !settings.demo;
    $('tracking-fields').disabled = $('save-tracking').disabled = false;
    $('tracking-default').focus();
  } catch (error) {
    if (request === trackingRequest) $('tracking-error').textContent = error.message;
  }
});
$('cancel-tracking').addEventListener('click', () => $('tracking-dialog').close());
$('tracking-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!trackingInitial || $('save-tracking').disabled) return;
  const target = trackingTarget;
  const request = trackingRequest;
  const defaultEnabled = $('tracking-default').value === 'on';
  const mode = $('tracking-project').value;
  const changes = {};
  if (defaultEnabled !== trackingInitial.defaultEnabled) changes.defaultEnabled = defaultEnabled;
  if (target && mode !== trackingInitial.mode) changes.mode = mode;
  if (!Object.keys(changes).length) {
    $('tracking-dialog').close();
    return;
  }
  $('tracking-fields').disabled = $('save-tracking').disabled = true;
  $('tracking-error').textContent = '';
  try {
    await api(projectRoute('/api/tracking', target), jsonOptions(changes));
    if (request === trackingRequest) $('tracking-dialog').close();
    await refresh();
  } catch (error) {
    if (request === trackingRequest) $('tracking-error').textContent = error.message;
  } finally {
    if (request === trackingRequest) $('tracking-fields').disabled = $('save-tracking').disabled = false;
  }
});

$('project').addEventListener('change', event => switchProject(event.target.value));
$('branch').addEventListener('change', event => switchBranch(event.target.value));
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
    await api(projectRoute(`/api/changes/${detail.history_id ?? id}/reason`, origin), jsonOptions({ reason: $('reason-input').value }));
    if (project === origin && selected === id) {
      $('reason-form').hidden = true;
      await loadDetail(id, file?.position);
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
  const dropdown = document.querySelector('.dropdown[open]');
  if (event.key === 'Escape' && dropdown && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    closeDropdown(dropdown, true);
    return;
  }
  if (document.querySelector('dialog[open]') || event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || event.target.matches?.('input, textarea, select, [contenteditable]')) return;
  event.preventDefault();
  $('search').focus();
});
async function pollTimeline() {
  if (!document.hidden) await refresh();
  setTimeout(pollTimeline, 800);
}

translateInterface();
void pollTimeline();
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
