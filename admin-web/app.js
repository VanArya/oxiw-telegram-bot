const FIREBASE_SDK_VERSION = '13.1.0';
const API_ROOT = '/api/v1/admin/catalog';
const { createAuthSessionCoordinator } = globalThis.OXIWAuthSessionCoordinator;
const PERMISSION_LABELS = Object.freeze({
  'catalog.admin.read': 'مشاهدهٔ مدیریتی',
  'catalog.metadata.write': 'ویرایش فراداده',
  'catalog.content.approve': 'تأیید یا رد محتوا',
  'catalog.content.publish': 'انتشار و بایگانی',
  'catalog.categories.manage': 'مدیریت دسته‌بندی‌ها',
  'catalog.taxonomies.manage': 'مدیریت کشور و ژانر',
});
const STATUS_LABELS = Object.freeze({
  pending: 'در انتظار', approved: 'تأییدشده', rejected: 'ردشده', unknown: 'نامشخص',
  draft: 'پیش‌نویس', published: 'منتشرشده', archived: 'بایگانی',
  active: 'فعال', disabled: 'غیرفعال',
});

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const elements = Object.fromEntries([
  'bootScreen', 'bootMessage', 'missingConfig', 'bootRetry', 'loginScreen', 'loginMessage',
  'noAccessScreen', 'noAccessMessage', 'noAccessEmail', 'noAccessUid', 'dashboard',
  'globalMessage', 'contentRows', 'contentCount', 'contentPage', 'contentPrev', 'contentNext', 'contentSourceWarning',
  'contentSearch', 'contentKind', 'contentApproval', 'contentPublication', 'contentCountry', 'contentGenre', 'contentCategory', 'statsGrid',
  'contentDialog', 'dialogMessage', 'metadataForm', 'metadataSave', 'metadataCountries',
  'metadataGenres', 'metadataCategories', 'toast', 'categoryList', 'categoryForm', 'countryList', 'genreList',
  'countryForm', 'genreForm', 'auditRows', 'auditPage', 'auditPrev', 'auditNext',
  'managerNav', 'managerNew', 'managerRefresh', 'managerMessage', 'managerForm',
  'managerCancel', 'managerEmail', 'managerRoles', 'managerSave', 'managerRows',
].map((name) => [
  name,
  document.getElementById(name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)),
]));

let auth;
let signOutCurrentUser;
let currentUser = null;
let session = null;
let firebaseConfig = null;
let contentPage = 1;
let contentLifecycleStatus = 'active';
let auditPage = 1;
let contentTotal = 0;
let auditHasMore = false;
let contentStats = null;
let contentFilterOptionsLoaded = false;
let currentItems = [];
const selectedContentIds = new Set();
let selectedItem = null;
let selectedMetadata = null;
let selectedSource = null;
let creatingSourceKind = null;
let selectedEtag = null;
let seriesStructure = [];
let structureEditor = null;
let countryTerms = [];
let genreTerms = [];
let categoryTerms = [];
let selectedTaxonomy = { type: null, id: null, etag: null };
let selectedCategory = { id: null, etag: null };
let toastTimer;
let authSessionCoordinator;
let managerAccessAllowed = false;
const managerEmailById = new Map();

function setText(element, value) {
  if (element) element.textContent = value == null ? '' : String(value);
}

function setGlobalMessage(message, { requestId, tone = 'error' } = {}) {
  elements.globalMessage.replaceChildren();
  const text = document.createElement('span');
  text.textContent = message;
  elements.globalMessage.append(text);
  if (requestId) {
    const reference = document.createElement('code');
    reference.textContent = `شناسهٔ پیگیری: ${requestId}`;
    elements.globalMessage.append(reference);
  }
  elements.globalMessage.dataset.tone = tone;
  elements.globalMessage.hidden = false;
}

function clearGlobalMessage() {
  elements.globalMessage.hidden = true;
  elements.globalMessage.replaceChildren();
}

function showToast(message, tone = 'success') {
  setText(elements.toast, message);
  elements.toast.dataset.tone = tone;
  elements.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 3600);
}

function showLogin(message = 'ورود موفق به‌تنهایی دسترسی مدیریتی ایجاد نمی‌کند.') {
  elements.bootScreen.hidden = true;
  elements.noAccessScreen.hidden = true;
  elements.dashboard.hidden = true;
  elements.loginScreen.hidden = false;
  setManagerAccessVisible(false);
  setText(elements.loginMessage, message);
}

function showNoAccess(user, message) {
  elements.bootScreen.hidden = true;
  elements.loginScreen.hidden = true;
  elements.dashboard.hidden = true;
  elements.noAccessScreen.hidden = false;
  setManagerAccessVisible(false);
  setText(elements.noAccessMessage, message || 'حساب شما احراز شد، اما نقش فعال و مجاز برای پنل پیدا نشد.');
  setText(elements.noAccessEmail, user?.email || 'ایمیل در دسترس نیست');
  setText(elements.noAccessUid, user?.uid || '');
}

function showDashboard() {
  elements.bootScreen.hidden = true;
  elements.loginScreen.hidden = true;
  elements.noAccessScreen.hidden = true;
  elements.dashboard.hidden = false;
  setManagerAccessVisible(false);
  setText($('#top-email'), currentUser?.email || 'ایمیل در دسترس نیست');
  setText($('#top-role'), session?.roles?.map(roleLabel).join('، ') || 'بدون نقش');
  setText($('#account-email'), currentUser?.email || 'ایمیل در دسترس نیست');
  setText($('#account-uid'), session?.subjectId || '');
  renderPermissionAccess();
  renderAccountAccess();
}

function setManagerAccessVisible(visible) {
  managerAccessAllowed = Boolean(visible);
  if (elements.managerNav) elements.managerNav.hidden = false;
  if (elements.managerSave) elements.managerSave.disabled = !managerAccessAllowed;
  if (elements.managerRoles) {
    Array.from(elements.managerRoles.querySelectorAll('input')).forEach((control) => { control.disabled = !managerAccessAllowed; });
  }
  Array.from(elements.managerRows.querySelectorAll('button, input')).forEach((control) => {
    control.disabled = !managerAccessAllowed;
  });
  if (!managerAccessAllowed && elements.managerMessage) {
    setManagerMessage('ثبت و لغو دسترسی تا تأیید مالک در سمت سرور غیرفعال است.');
  }
}

function roleLabel(role) {
  const labels = {
    observer: 'ناظر', editor: 'ویرایشگر', approver: 'تأییدکننده', publisher: 'ناشر',
    taxonomy_manager: 'مدیر دسته‌ها', administrator: 'مدیر سامانه',
  };
  return labels[role] || 'نقش نامعتبر';
}

function messageForError(error) {
  const messages = {
    INVALID_INPUT: 'داده‌های واردشده معتبر نیستند.',
    INVALID_FILTER: 'فیلتر یا جست‌وجو معتبر نیست.',
    INVALID_PAGINATION: 'صفحه‌بندی معتبر نیست.',
    UNAUTHENTICATED: 'نشست معتبر نیست؛ دوباره وارد شوید.',
    FORBIDDEN: 'مجوز لازم برای این عملیات را ندارید.',
    NOT_FOUND: 'رکورد پیدا نشد.',
    ALREADY_EXISTS: 'کد سیستم جدید از قبل ثبت شده است.',
    CONFLICT: 'عملیات با داده‌های موجود سازگار نیست.',
    APPROVAL_REQUIRED: 'برای انتشار، محتوا باید ابتدا تأیید شود.',
    PRECONDITION_REQUIRED: 'نسخهٔ رکورد لازم است؛ داده را دوباره دریافت کنید.',
    PRECONDITION_FAILED: 'داده پس از آخرین بارخوانی تغییر کرده است.',
    LAST_ADMINISTRATOR: 'این تغییر آخرین مدیر فعال را حذف می‌کند و مجاز نیست.',
    NO_CHANGE: 'نقش‌های انتخاب‌شده با وضعیت فعلی تفاوتی ندارند.',
    OWNER_ADMIN_REQUIRED: 'دسترسی مدیریتی حساب مالک از این بخش قابل لغو نیست.',
    AUTHENTICATION_UNAVAILABLE: 'بررسی هویت موقتاً در دسترس نیست.',
    ROLE_RESOLUTION_UNAVAILABLE: 'بررسی نقش‌ها موقتاً در دسترس نیست.',
    AUTHORIZATION_UNAVAILABLE: 'بررسی مجوز موقتاً در دسترس نیست.',
    OWNER_REQUIRED: 'این بخش فقط برای مالک مجاز است.',
    OWNER_AUTH_NOT_CONFIGURED: 'احراز هویت مالک برای این بخش پیکربندی نشده است.',
    OWNER_AUTH_UNAVAILABLE: 'احراز هویت مالک موقتاً در دسترس نیست.',
    ADMIN_ROLE_MANAGEMENT_NOT_CONFIGURED: 'مدیریت مدیران هنوز به منبع مورداعتماد متصل نشده است.',
    TARGET_INVALID: 'حساب هدف معتبر نیست.',
    INVALID_TARGET: 'حساب هدف معتبر نیست.',
    LAST_ADMINISTRATOR: 'لغو این دسترسی آخرین مدیر فعال را حذف می‌کند.',
    INTERNAL_ERROR: 'سرویس نتوانست درخواست را انجام دهد.',
  };
  return messages[error?.body?.error?.code] || 'درخواست انجام نشد؛ وضعیت سرویس را دوباره بررسی کنید.';
}

class ApiError extends Error {
  constructor(status, body) {
    super(messageForError({ body }));
    this.status = status;
    this.body = body;
    this.requestId = body?.error?.requestId;
    this.code = body?.error?.code;
  }
}

async function parseResponse(response) {
  let body;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) throw new ApiError(response.status, body);
  return { body, etag: response.headers.get('etag') };
}

async function api(path, options = {}, allowRefresh = true) {
  if (!currentUser) throw new ApiError(401, { error: { code: 'UNAUTHENTICATED' } });
  let token;
  try { token = await currentUser.getIdToken(); } catch {
    throw new ApiError(401, { error: { code: 'UNAUTHENTICATED' } });
  }
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  let response;
  try {
    response = await fetch(path, { ...options, headers, cache: 'no-store' });
  } catch {
    throw new ApiError(503, { error: { code: 'INTERNAL_ERROR' } });
  }
  if (response.status === 401 && allowRefresh) {
    try { await currentUser.getIdToken(true); } catch { /* handled as a safe 401 below */ }
    return api(path, options, false);
  }
  return parseResponse(response);
}

function reportApiError(error, fallback = 'درخواست انجام نشد.') {
  if (error.status === 401) {
    showToast('نشست شما معتبر نیست؛ وضعیت ورود را دوباره بررسی کنید.', 'error');
    void signOutCurrentUser?.();
    return;
  }
  setGlobalMessage(error.message || fallback, { requestId: error.requestId });
}

function hasPermission(permission) {
  return Array.isArray(session?.permissions) && session.permissions.includes(permission);
}

function renderPermissionAccess() {
  $$('[data-permission]').forEach((item) => {
    item.hidden = !hasPermission(item.dataset.permission);
  });
  $$('.permission-action').forEach((item) => {
    item.hidden = !hasPermission(item.dataset.permission);
  });
}

function renderAccountAccess() {
  const roles = $('#account-roles');
  const permissions = $('#account-permissions');
  roles.replaceChildren();
  permissions.replaceChildren();
  (session?.roles || []).forEach((role) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = roleLabel(role);
    roles.append(chip);
  });
  (session?.permissions || []).forEach((permission) => {
    const row = document.createElement('div');
    row.className = 'permission-row';
    const name = document.createElement('span');
    name.textContent = PERMISSION_LABELS[permission] || 'مجوز نامشخص';
    const code = document.createElement('code');
    code.textContent = permission;
    row.append(name, code);
    permissions.append(row);
  });
}

function selectView(view, kind) {
  if (view === "content" && kind) elements.contentKind.value = kind;
  if (view === "content") setText($("#view-content h1"), kind === "series" ? "سریال‌ها" : "فیلم‌ها");
  $$('.view').forEach((section) => section.classList.toggle('active-view', section.id === `view-${view}`));
  $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === view && (!button.dataset.kind || button.dataset.kind === elements.contentKind.value)));
  clearGlobalMessage();
  const loaders = {
    overview: loadOverview,
    content: loadContent,
    categories: loadCategories,
    countries: () => loadTaxonomy('country'),
    genres: () => loadTaxonomy('genre'),
    audit: loadAudit,
    managers: loadManagers,
  };
  if (loaders[view]) void loaders[view]();
}

function setManagerMessage(message, tone = 'error') {
  if (!elements.managerMessage) return;
  setText(elements.managerMessage, message);
  elements.managerMessage.dataset.tone = tone;
  elements.managerMessage.hidden = false;
}

function clearManagerMessage() {
  if (!elements.managerMessage) return;
  elements.managerMessage.hidden = true;
  elements.managerMessage.replaceChildren();
}

function managerEtag(subjectId, version) {
  const encoded = btoa(`manager:${subjectId}`)
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `"catalog-v1.${encoded}.v${version}"`;
}

const MANAGER_ROLE_OPTIONS = Object.freeze([
  { value: 'observer', label: 'ناظر' },
  { value: 'editor', label: 'ویرایشگر' },
  { value: 'approver', label: 'تأییدکننده' },
  { value: 'publisher', label: 'ناشر' },
  { value: 'taxonomy_manager', label: 'مدیر دسته‌ها' },
  { value: 'administrator', label: 'مدیر سامانه' },
]);

function renderManagerRoleSummary(assignment, cell) {
  cell.replaceChildren();
  const wrapper = document.createElement('div');
  wrapper.className = 'manager-role-summary';
  const summary = document.createElement('span');
  summary.textContent = (assignment.roles || []).map(roleLabel).join('، ') || '—';
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'button button-small button-secondary';
  edit.textContent = 'ویرایش نقش';
  edit.disabled = !managerAccessAllowed;
  edit.addEventListener('click', () => openManagerRoleEditor(assignment, cell));
  wrapper.append(summary, edit);
  cell.append(wrapper);
}

function openManagerRoleEditor(assignment, cell) {
  cell.replaceChildren();
  const form = document.createElement('form');
  form.className = 'manager-role-editor';
  const heading = document.createElement('strong');
  heading.textContent = 'نقش‌های فعال';
  form.append(heading);

  MANAGER_ROLE_OPTIONS.forEach(({ value, label }) => {
    const option = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.name = 'roles';
    checkbox.value = value;
    checkbox.checked = assignment.roles.includes(value);
    option.append(checkbox, document.createTextNode(label));
    form.append(option);
  });

  const actions = document.createElement('div');
  actions.className = 'form-actions';
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'button button-small button-primary';
  save.textContent = 'ذخیره نقش‌ها';
  save.disabled = !managerAccessAllowed;
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'button button-small button-secondary';
  cancel.textContent = 'انصراف';
  cancel.addEventListener('click', () => renderManagerRoleSummary(assignment, cell));
  actions.append(save, cancel);
  form.append(actions);
  form.addEventListener('submit', (event) => void updateManagerRoles(event, assignment, form));
  cell.append(form);
}

async function updateManagerRoles(event, assignment, form) {
  event.preventDefault();
  if (!managerAccessAllowed) {
    setManagerMessage('تغییر نقش‌ها فقط برای مالک مجاز است.');
    return;
  }
  const roles = [...form.querySelectorAll('input[name="roles"]:checked')].map((input) => input.value);
  if (roles.length === 0) {
    setManagerMessage('هر مدیر فعال باید دست‌کم یک نقش داشته باشد.');
    return;
  }
  if (!window.confirm('نقش‌های این مدیر با انتخاب جدید جایگزین شوند؟')) return;
  const save = form.querySelector('button[type="submit"]');
  setBusy(save, true);
  setManagerMessage('در حال ذخیرهٔ نقش‌ها…', 'neutral');
  try {
    await api(`${API_ROOT}/managers/${encodeURIComponent(assignment.subjectId)}`, {
      method: 'PATCH',
      headers: { 'If-Match': managerEtag(assignment.subjectId, assignment.version) },
      body: JSON.stringify({ roles }),
    });
    showToast('نقش‌های مدیر به‌روزرسانی شد.');
    await loadManagers();
  } catch (error) {
    if (error.status === 403) setManagerAccessVisible(false);
    setManagerMessage(error.message || 'تغییر نقش‌ها انجام نشد.');
    if (error.status === 401) reportApiError(error);
  } finally {
    setBusy(save, false);
  }
}

function renderManagers(assignments) {
  elements.managerRows.replaceChildren();
  if (!assignments.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.className = 'empty-message';
    cell.textContent = 'مدیر فعالی ثبت نشده است.';
    row.append(cell);
    elements.managerRows.append(row);
    return;
  }
  assignments.forEach((assignment) => {
    const row = document.createElement('tr');
    const email = document.createElement('td');
    email.textContent = assignment.email || managerEmailById.get(assignment.subjectId) || 'ایمیل در دسترس نیست';
    const subject = document.createElement('td');
    subject.className = 'mono';
    subject.textContent = assignment.subjectId;
    const roles = document.createElement('td');
    renderManagerRoleSummary(assignment, roles);
    const status = document.createElement('td');
    status.textContent = assignment.active ? 'فعال' : 'غیرفعال';
    const version = document.createElement('td');
    version.textContent = String(assignment.version ?? '—');
    const action = document.createElement('td');
    const actions = document.createElement('div');
    actions.className = 'manager-role-actions';
    const revoke = document.createElement('button');
    revoke.type = 'button';
    revoke.className = 'button button-small button-danger';
    revoke.textContent = 'لغو دسترسی';
    revoke.disabled = !managerAccessAllowed;
    revoke.addEventListener('click', () => void revokeManager(assignment));
    actions.append(revoke);
    action.append(actions);
    row.append(email, subject, roles, status, version, action);
    elements.managerRows.append(row);
  });
}

async function loadManagers({ probe = false } = {}) {
  try {
    const { body } = await api(`${API_ROOT}/managers`);
    if (!currentUser || !session) return;
    const assignments = Array.isArray(body?.data) ? body.data : [];
    setManagerAccessVisible(true);
    renderManagers(assignments);
    if (!probe) clearManagerMessage();
  } catch (error) {
    setManagerAccessVisible(false);
    if (error.status === 403 || error.code === 'OWNER_REQUIRED') {
      if (!probe) setManagerMessage('این بخش فقط برای مالک مجاز است.');
      return;
    }
    if (!probe) {
      setManagerMessage(error.message || 'فهرست مدیران در دسترس نیست.');
      if (error.status === 401) reportApiError(error);
    }
  }
}

async function addManager(event) {
  event.preventDefault();
  if (!managerAccessAllowed) {
    setManagerMessage('ثبت مدیر تا تأیید مالک در سمت سرور غیرفعال است.');
    return;
  }
  if (!elements.managerForm.checkValidity()) return;
  const email = elements.managerEmail.value.trim();
  const roles = Array.from(elements.managerRoles.querySelectorAll('input[name="manager-new-role"]:checked')).map((input) => input.value);
  if (roles.length === 0) {
    setManagerMessage('برای مدیر جدید دست‌کم یک نقش انتخاب کنید.');
    return;
  }
  if (!window.confirm('این حساب با نقش‌های انتخاب‌شده به فهرست مدیران اضافه شود؟')) return;
  setBusy(elements.managerSave, true);
  clearManagerMessage();
  try {
    const { body } = await api(`${API_ROOT}/managers`, {
      method: 'POST',
      body: JSON.stringify({ email, roles }),
    });
    const assignment = body?.data;
    if (assignment?.subjectId) managerEmailById.set(assignment.subjectId, email);
    elements.managerForm.reset();
    elements.managerForm.hidden = true;
    showToast(assignment?.reactivated
      ? 'مدیر دوباره فعال شد؛ نقش‌های قبلی حفظ شدند.'
      : 'مدیر با نقش‌های انتخاب‌شده اضافه شد.');
    await loadManagers();
  } catch (error) {
    if (error.status === 403) setManagerAccessVisible(false);
    setManagerMessage(error.message || 'افزودن مدیر انجام نشد.');
    if (error.status === 401) reportApiError(error);
  } finally { setBusy(elements.managerSave, false); }
}

async function revokeManager(assignment) {
  if (!managerAccessAllowed || !window.confirm('دسترسی این مدیر لغو شود؟')) return;
  const subjectId = assignment.subjectId;
  setManagerMessage('در حال لغو دسترسی…', 'neutral');
  try {
    await api(`${API_ROOT}/managers/${encodeURIComponent(subjectId)}`, {
      method: 'DELETE',
      headers: { 'If-Match': managerEtag(subjectId, assignment.version) },
    });
    showToast('دسترسی مدیر لغو شد.');
    await loadManagers();
  } catch (error) {
    if (error.status === 403) setManagerAccessVisible(false);
    setManagerMessage(error.message || 'لغو دسترسی انجام نشد.');
    if (error.status === 401) reportApiError(error);
  }
}

function setBusy(button, busy) {
  if (!button) return;
  if (busy) {
    button.dataset.previousText = button.textContent;
    button.disabled = true;
  } else {
    button.disabled = false;
    if (button.dataset.previousText) button.textContent = button.dataset.previousText;
    delete button.dataset.previousText;
  }
}

function renderStats(stats) {
  const labels = [
    ['total', 'کل محتوا'], ['movies', 'فیلم سینمایی'], ['series', 'سریال'],
    ['pending', 'در انتظار تأیید'], ['approved', 'تأییدشده'], ['published', 'منتشرشده'],
    ['draft', 'پیش‌نویس'], ['missingMetadata', 'فاقد فراداده'],
  ];
  elements.statsGrid.replaceChildren();
  labels.forEach(([key, label], index) => {
    const card = document.createElement('article');
    card.className = `stat-card stat-${index % 4}`;
    const number = document.createElement('strong');
    number.textContent = Number(stats?.[key] || 0).toLocaleString('fa-IR');
    const caption = document.createElement('span');
    caption.textContent = label;
    card.append(number, caption);
    elements.statsGrid.append(card);
  });
}

async function loadOverview() {
  try {
    const { body } = await api(`${API_ROOT}/items?page=1&pageSize=1`);
    contentStats = body.meta.stats;
    renderStats(contentStats);
    clearGlobalMessage();
  } catch (error) { reportApiError(error); }
}

function yearLabel(item) {
  if (item.kind === 'movie') return item.releaseYear ?? '—';
  const series = item.seriesMetadata || {};
  const start = series.startYear ?? '—';
  const end = series.isOngoing ? 'در حال پخش' : (series.endYear ?? '—');
  return `${start} – ${end}`;
}

function statusBadge(status) {
  const badge = document.createElement('span');
  badge.className = `badge badge-${status || 'unknown'}`;
  badge.textContent = STATUS_LABELS[status] || 'نامشخص';
  return badge;
}

function renderContentRows(items) {
  elements.contentRows.replaceChildren();
  items.forEach((item) => {
    const row = document.createElement('tr');
    const selection = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'content-row-select';
    const isChildItem = item.kind === 'season' || item.kind === 'episode';
    checkbox.checked = selectedContentIds.has(item.id);
    checkbox.disabled = isChildItem;
    checkbox.hidden = isChildItem;
    checkbox.setAttribute('aria-label', `انتخاب ${item.title}`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedContentIds.add(item.id);
      else selectedContentIds.delete(item.id);
      updateBulkControls();
    });
    selection.append(checkbox);
    const title = document.createElement('td');
    title.textContent = item.title;
    const kind = document.createElement('td');
    kind.textContent = ({ movie: 'سینمایی', series: 'سریال', season: 'فصل', episode: 'قسمت' })[item.kind] || 'نامشخص';
    const code = document.createElement('td');
    code.className = 'mono';
    code.textContent = item.systemCode;
    const year = document.createElement('td');
    year.textContent = yearLabel(item);
    const approval = document.createElement('td');
    approval.append(statusBadge(item.approvalStatus));
    const publication = document.createElement('td');
    publication.append(statusBadge(item.publicationStatus));
    const metadata = document.createElement('td');
    metadata.append(statusBadge(item.hasMetadata ? 'approved' : 'unknown'));
    metadata.lastChild.textContent = item.hasMetadata ? 'ثبت‌شده' : 'نیازمند فراداده';
    const action = document.createElement('td');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'button button-small button-secondary';
    open.textContent = isChildItem ? 'سریال مادر' : 'مدیریت';
    open.addEventListener('click', () => void (isChildItem ? openParentSeries(item) : openContent(item)));
    action.append(open);
    const lifecycle = document.createElement('button');
    lifecycle.type = 'button';
    lifecycle.className = 'button button-small ' + (item.lifecycleStatus === 'disabled' ? 'button-primary' : 'button-danger');
    lifecycle.textContent = item.lifecycleStatus === 'disabled' ? 'بازگردانی' : 'غیرفعال‌سازی';
    lifecycle.disabled = !hasPermission('catalog.metadata.write');
    lifecycle.addEventListener('click', () => void changeContentLifecycle(item,
      item.lifecycleStatus === 'disabled' ? 'active' : 'disabled'));
    action.append(lifecycle);
    if (item.lifecycleStatus === 'disabled' && ((item.kind === 'season' || item.kind === 'episode')
      ? hasPermission('catalog.metadata.write') : (session?.roles || []).includes('administrator'))) {
      const permanentDelete = document.createElement('button');
      permanentDelete.type = 'button';
      permanentDelete.className = 'button button-small button-danger';
      permanentDelete.textContent = 'حذف دائم';
      permanentDelete.addEventListener('click', () => void permanentlyDeleteContent(item));
      action.append(permanentDelete);
    }
    row.append(selection, title, kind, code, year, approval, publication, metadata, action);
    elements.contentRows.append(row);
  });
}

function updateBulkControls() {
  const selectableIds = currentItems.filter((item) => item.kind === 'movie' || item.kind === 'series').map((item) => item.id);
  const count = contentLifecycleStatus === 'active' ? selectedContentIds.size : 0;
  const bar = $('#content-bulk-actions');
  if (bar) bar.hidden = count === 0 || contentLifecycleStatus !== 'active';
  setText($('#content-selected-count'), `${count.toLocaleString('fa-IR')} مورد انتخاب شده`);
  const all = $('#content-select-all');
  if (all) {
    const visible = selectableIds;
    all.checked = visible.length > 0 && visible.every((id) => selectedContentIds.has(id));
    all.indeterminate = visible.some((id) => selectedContentIds.has(id)) && !all.checked;
  }
  $('#bulk-approve').disabled = !hasPermission('catalog.content.approve') || count === 0;
  $('#bulk-publish').disabled = !hasPermission('catalog.content.publish') || count === 0;
}

async function runBulkStatus(kind, status) {
  const ids = [...selectedContentIds];
  if (!ids.length) return;
  const label = kind === 'approval' ? 'تأیید' : 'انتشار';
  if (!window.confirm(`${ids.length} عنوان انتخاب‌شده برای عملیات «${label}» پردازش شوند؟\nانتشار فقط برای موارد تأییدشده امکان‌پذیر است.`)) return;
  const button = kind === 'approval' ? $('#bulk-approve') : $('#bulk-publish');
  setBusy(button, true);
  try {
    const field = kind === 'approval' ? 'approvalStatus' : 'publicationStatus';
    const { body } = await api(`${API_ROOT}/items/bulk/${kind}`, {
      method: 'POST',
      body: JSON.stringify({ contentIds: ids, [field]: status }),
    });
    const succeeded = body.meta?.succeeded || 0;
    const failed = body.meta?.failed || 0;
    body.data.filter((item) => item.success).forEach((item) => selectedContentIds.delete(item.contentId));
    await loadContent();
    updateBulkControls();
    showToast(`${succeeded} مورد موفق، ${failed} مورد ناموفق. جزئیات موارد ناموفق در پیام زیر نمایش داده می‌شود.`, failed ? 'error' : 'success');
    const failures = body.data.filter((item) => !item.success);
    if (failures.length) {
      const reasons = failures.slice(0, 8).map((item) => {
        const reason = item.code === 'APPROVAL_REQUIRED' ? 'ابتدا باید تأیید شود'
          : item.code === 'METADATA_REQUIRED' ? 'فرادادهٔ پایه ثبت نشده'
            : item.code === 'PRECONDITION_FAILED' ? 'هم‌زمان تغییر کرده'
              : 'خطای ذخیره‌سازی';
        return `${item.contentId}: ${reason}`;
      });
      setGlobalMessage(reasons.join(' · '), { tone: 'warning' });
    }
  } catch (error) { reportApiError(error); }
  finally { setBusy(button, false); }
}

function contentQuery() {
  const params = new URLSearchParams({ page: String(contentPage), pageSize: '20' });
  const q = elements.contentSearch.value.trim();
  if (q) params.set('q', q);
  params.set('lifecycleStatus', contentLifecycleStatus);
  if (elements.contentKind.value) params.set('kind', elements.contentKind.value);
  if (elements.contentApproval.value) params.set('approvalStatus', elements.contentApproval.value);
  if (elements.contentPublication.value) params.set('publicationStatus', elements.contentPublication.value);
  if (elements.contentCountry.value) params.set('countryId', elements.contentCountry.value);
  if (elements.contentGenre.value) params.set('genreId', elements.contentGenre.value);
  if (elements.contentCategory.value) params.set('categoryId', elements.contentCategory.value);
  return params;
}

function populateFilterSelect(select, terms, labelFor) {
  const current = select.value;
  select.replaceChildren(new Option('همه', ''));
  terms.filter((term) => term.enabled).forEach((term) => {
    select.append(new Option(labelFor(term), term.id));
  });
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

async function loadContentFilterOptions() {
  const [countriesResult, genresResult, categoriesResult] = await Promise.all([
    api(`${API_ROOT}/taxonomies/country`),
    api(`${API_ROOT}/taxonomies/genre`),
    api(`${API_ROOT}/categories`),
  ]);
  countryTerms = countriesResult.body.data;
  genreTerms = genresResult.body.data;
  categoryTerms = categoriesResult.body.data;
  populateFilterSelect(elements.contentCountry, countryTerms, (term) => term.labelFa);
  populateFilterSelect(elements.contentGenre, genreTerms, (term) => term.labelFa);
  populateFilterSelect(elements.contentCategory, categoryTerms, (term) =>
    term.localizedTitle?.fa || term.slug || term.id);
}

async function changeContentLifecycle(item, lifecycleStatus) {
  if (!item || !hasPermission('catalog.metadata.write')) return;
  const disabling = lifecycleStatus === 'disabled';
  const actionLabel = disabling ? 'غیرفعال‌سازی' : 'بازگردانی';
  const warning = item.kind === 'series' && disabling
    ? 'تمام فصل‌ها و قسمت‌های این سریال نیز از نمایش عمومی خارج می‌شوند و با بازگردانی سریال دوباره در دسترس قرار می‌گیرند؛ وضعیت مستقل فصل‌ها و قسمت‌ها حفظ می‌شود.'
    : disabling ? 'این مورد از نمایش عمومی خارج می‌شود.' : 'این مورد دوباره فعال می‌شود.';
  if (!window.confirm(`${actionLabel} «${item.title}» انجام شود؟\n${warning}`)) return;
  try {
    let path;
    let etag;
    if (item.kind === 'season' || item.kind === 'episode') {
      const base = `${API_ROOT}/items/${encodeURIComponent(item.parentContentId)}/seasons/${item.seasonNumber}`;
      path = item.kind === 'season' ? base : `${base}/episodes/${item.episodeNumber}`;
      const current = await api(path);
      etag = current.etag;
      path += '/lifecycle';
    } else {
      path = `${API_ROOT}/items/${encodeURIComponent(item.id)}/lifecycle`;
      try {
        const current = await api(`${API_ROOT}/items/${encodeURIComponent(item.id)}/metadata`);
        etag = current.etag;
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    await api(path, {
      method: 'PATCH',
      headers: etag ? { 'If-Match': etag } : { 'If-None-Match': '*' },
      body: JSON.stringify({ lifecycleStatus }),
    });
    showToast(disabling ? 'مورد غیرفعال شد.' : 'مورد بازگردانی شد.', 'success');
    selectedContentIds.delete(item.id);
    await loadContent();
    if (selectedItem?.id === item.parentContentId || selectedItem?.id === item.id) await loadSeriesStructure();
  } catch (error) {
    if (error.status === 412) {
      showToast('اطلاعات هم‌زمان تغییر کرده است؛ فهرست را تازه‌سازی کنید.', 'error');
      await loadContent();
    } else reportApiError(error);
  }
}

async function permanentlyDeleteContent(item) {
  if (!item || item.lifecycleStatus !== 'disabled') return;
  if ((item.kind === 'movie' || item.kind === 'series') && !item.sourceVersion) return;
  if (!window.confirm(`حذف دائم «${item.title}» انجام شود؟\nاین عملیات قابل بازگشت نیست و اطلاعات وابسته نیز حذف خواهند شد.`)) return;
  try {
    if (item.kind === 'season' || item.kind === 'episode') {
      const base = `${API_ROOT}/items/${encodeURIComponent(item.parentContentId)}/seasons/${item.seasonNumber}`;
      const path = item.kind === 'season' ? base : `${base}/episodes/${item.episodeNumber}`;
      const current = await api(path);
      await api(path, { method: 'DELETE', headers: { 'If-Match': current.etag } });
    } else {
      const current = await api(`${API_ROOT}/items/${encodeURIComponent(item.id)}/metadata`);
      await api(`${API_ROOT}/items/${encodeURIComponent(item.id)}`, {
        method: 'DELETE',
        headers: { 'If-Match': current.etag },
        body: JSON.stringify({ sourceVersion: item.sourceVersion }),
      });
    }
    showToast('مورد به‌صورت دائم حذف شد.', 'success');
    await loadContent();
    if (selectedItem?.id === item.parentContentId) await loadSeriesStructure();
  } catch (error) {
    if (error.status === 412) {
      showToast('اطلاعات محتوا تغییر کرده است؛ فهرست را تازه‌سازی و دوباره بررسی کنید.', 'error');
      await loadContent();
    } else if (error.status === 403) {
      showToast('حذف دائم این مورد مجاز نیست.', 'error');
    } else reportApiError(error);
  }
}

async function loadContent() {
  const button = $('#content-search-button');
  setBusy(button, true);
  try {
    if (!contentFilterOptionsLoaded) {
      await loadContentFilterOptions();
      contentFilterOptionsLoaded = true;
    }
    const { body } = await api(`${API_ROOT}/items?${contentQuery()}`);
    currentItems = body.data;
    const visibleIds = new Set(currentItems.map((item) => item.id));
    for (const id of selectedContentIds) if (!visibleIds.has(id)) selectedContentIds.delete(id);
    contentTotal = body.meta.total;
    contentStats = body.meta.stats;
    const invalidSourceRows = Number(body.meta.invalidSourceRows) || 0;
    elements.contentSourceWarning.hidden = invalidSourceRows === 0;
    setText(elements.contentSourceWarning, invalidSourceRows
      ? `هشدار: ${invalidSourceRows.toLocaleString('fa-IR')} ردیف نامعتبر از شیت نادیده گرفته شد. فهرست موارد سالم نمایش داده شده است؛ برای شناسایی دقیق ردیف‌ها، لاگ سرویس را بررسی کنید.`
      : '');
    renderContentRows(currentItems);
    updateBulkControls();
    setText(elements.contentCount, `${contentTotal.toLocaleString('fa-IR')} مورد`);
    setText(elements.contentPage, `صفحهٔ ${body.meta.page.toLocaleString('fa-IR')}`);
    elements.contentPrev.disabled = contentPage <= 1;
    elements.contentNext.disabled = contentPage * 20 >= contentTotal;
    clearGlobalMessage();
  } catch (error) { reportApiError(error); }
  finally { setBusy(button, false); }
}

function selectedValues(select) {
  return [...select.selectedOptions].map((option) => option.value);
}

function populateMultiSelect(select, terms, selected = []) {
  select.replaceChildren();
  terms.filter((term) => term.enabled || selected.includes(term.id)).forEach((term) => {
    const option = document.createElement('option');
    option.value = term.id;
    option.textContent = term.enabled ? term.labelFa : `${term.labelFa} (غیرفعال)`;
    option.selected = selected.includes(term.id);
    select.append(option);
  });
}

function setDialogMessage(message, tone = 'neutral') {
  setText(elements.dialogMessage, message);
  elements.dialogMessage.dataset.tone = tone;
  elements.dialogMessage.hidden = false;
}

function permissionControls() {
  elements.metadataSave.hidden = !hasPermission('catalog.metadata.write');
  $('#approval-actions').hidden = !hasPermission('catalog.content.approve');
  $('#publication-actions').hidden = !hasPermission('catalog.content.publish');
}

function renderSheetFields(container, headers, record = {}, { create = false } = {}) {
  container.replaceChildren();
  headers.forEach((header) => {
    const label = document.createElement('label');
    label.textContent = header;
    const value = record[header] == null ? '' : String(record[header]);
    const longField = value.length > 120 || /خلاصه|توضیح|شرح|بازیگران|توضیحات|داستان/i.test(header);
    const control = document.createElement(longField ? 'textarea' : 'input');
    if (longField) control.rows = 4;
    else control.type = 'text';
    control.maxLength = 20000;
    control.value = value;
    control.dataset.sourceHeader = header;
    control.setAttribute('aria-label', header);
    if (header === 'کد سیستم' || header === 'اسم فیلم') control.required = true;
    if (/Telegram|File ID|URL|لینک|شناسه|کد/i.test(header)) control.dir = 'ltr';
    label.append(control);
    container.append(label);
  });
}

function readSheetFields(container, { create = false } = {}) {
  const fields = {};
  $$('[data-source-header]', container).forEach((control) => {
    const header = control.dataset.sourceHeader;
    fields[header] = control.value;
  });
  return fields;
}

function renderSourceForm(source) {
  selectedSource = source || null;
  const form = $('#source-form');
  if (!source || !hasPermission('catalog.metadata.write')) {
    form.hidden = true;
    return;
  }
  renderSheetFields($('#source-fields'), source.headers, source.record);
  form.hidden = false;
}

async function saveSourceItem(event) {
  event.preventDefault();
  if (!selectedItem || !selectedSource || !hasPermission('catalog.metadata.write')) return;
  const fields = readSheetFields($('#source-fields'));
  const button = $('#source-save');
  setBusy(button, true);
  try {
    const result = await api(API_ROOT + '/items/' + encodeURIComponent(selectedItem.id) + '/source', {
      method: 'PUT',
      body: JSON.stringify({ sourceVersion: selectedSource.sourceVersion, fields }),
    });
    const previousId = selectedItem.id;
    selectedSource = result.body.data;
    if (selectedSource.id !== previousId) {
      elements.contentDialog.close();
      selectedItem = null;
      selectedSource = null;
      await loadContent();
      const updatedItem = currentItems.find((item) => item.id === result.body.data.id);
      if (updatedItem) await openContent(updatedItem);
      showToast('کد سیستم تغییر کرد و وضعیت و فرادادهٔ قبلی حفظ شد.');
    } else {
      renderSourceForm(selectedSource);
      await loadContent();
      showToast('تمام ستون‌های ویرایش‌شده در Google Sheets ذخیره شدند.');
    }
  } catch (error) {
    if (error.status === 412) {
      await refreshSelectedContent('ردیف در Google Sheets تغییر کرده است؛ اطلاعات تازه بارگذاری شد و تغییر شما ذخیره نشد.');
      showToast('تعارض نسخه؛ اطلاعات را بازبینی و دوباره ذخیره کنید.', 'error');
    } else reportApiError(error);
  } finally { setBusy(button, false); }
}

async function openSourceCreate(kind) {
  if (!hasPermission('catalog.metadata.write')) return;
  creatingSourceKind = kind;
  const title = kind === 'movie' ? 'افزودن فیلم سینمایی' : 'افزودن سریال';
  setText($('#source-create-title'), title);
  try {
    const { body } = await api(`${API_ROOT}/source-schema/${kind}`);
    renderSheetFields($('#source-create-fields'), body.data.headers, {}, { create: true });
    $('#source-create-dialog').showModal();
  } catch (error) { reportApiError(error); }
}

async function createSourceItem(event) {
  event.preventDefault();
  if (!creatingSourceKind || !hasPermission('catalog.metadata.write')) return;
  const fields = readSheetFields($('#source-create-fields'), { create: true });
  const button = $('#source-create-save');
  setBusy(button, true);
  try {
    const { body } = await api(`${API_ROOT}/items/source`, {
      method: 'POST',
      body: JSON.stringify({ kind: creatingSourceKind, fields }),
    });
    $('#source-create-dialog').close();
    creatingSourceKind = null;
    let metadataReady = true;
    try {
      await api(`${API_ROOT}/items/${encodeURIComponent(body.data.id)}/metadata`, {
        method: 'PUT',
        headers: { 'If-None-Match': '*' },
        body: JSON.stringify({
          contentId: body.data.id, approvalStatus: 'pending', publicationStatus: 'draft',
          countryIds: [], genreIds: [],
        }),
      });
    } catch (metadataError) {
      metadataReady = false;
      reportApiError(metadataError, 'رکورد در شیت ثبت شد، اما ایجاد فرادادهٔ اولیه انجام نشد.');
    }
    contentPage = 1;
    elements.contentKind.value = body.data.kind;
    await loadContent();
    showToast(metadataReady
      ? 'عنوان در شیت و فهرست مدیریتی ثبت شد؛ وضعیت اولیه در انتظار تأیید و پیش‌نویس است.'
      : 'عنوان در شیت ثبت شد؛ فرادادهٔ اولیه را از پنجرهٔ مدیریت تکمیل کنید.',
      metadataReady ? 'success' : 'error');
    const created = currentItems.find((item) => item.id === body.data.id);
    if (created) await openContent(created);
  } catch (error) {
    if (error.status === 409) setGlobalMessage('کد سیستم تکراری است؛ یک شناسهٔ یکتا وارد کنید.');
    else reportApiError(error);
  } finally { setBusy(button, false); }
}

function structureApiPath(seasonNumber, episodeNumber) {
  const base = `${API_ROOT}/items/${encodeURIComponent(selectedItem.id)}/seasons/${seasonNumber}`;
  return episodeNumber === undefined ? base : `${base}/episodes/${episodeNumber}`;
}

function addStructureAction(parent, label, handler, variant = 'button-secondary') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `button button-small ${variant}`;
  button.textContent = label;
  button.disabled = !hasPermission('catalog.metadata.write');
  button.addEventListener('click', () => void handler());
  parent.append(button);
  return button;
}

function renderSeriesStructure() {
  const panel = $('#series-structure-panel');
  const list = $('#series-season-list');
  if (!panel || !list) return;
  panel.hidden = selectedItem?.kind !== 'series';
  if (panel.hidden) return;
  list.replaceChildren();
  if (seriesStructure.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'هنوز فصلی برای این سریال ثبت نشده است.';
    list.append(empty);
    return;
  }
  for (const season of seriesStructure) {
    const card = document.createElement('section');
    card.className = 'series-season-card panel';
    const heading = document.createElement('div');
    heading.className = 'panel-heading';
    const title = document.createElement('h4');
    title.textContent = season.title || `فصل ${season.seasonNumber}`;
    const status = statusBadge(season.lifecycleStatus);
    heading.append(title, status);
    card.append(heading);
    const seasonActions = document.createElement('div');
    seasonActions.className = 'form-actions';
    addStructureAction(seasonActions, 'ویرایش فصل', () => openStructureEditor({
      kind: 'season', mode: 'edit', seasonNumber: season.seasonNumber, value: season,
    }));
    addStructureAction(seasonActions, 'افزودن قسمت', () => openStructureEditor({
      kind: 'episode', mode: 'create', seasonNumber: season.seasonNumber,
    }), 'button-primary');
    addStructureAction(seasonActions, season.lifecycleStatus === 'disabled' ? 'بازگردانی فصل' : 'غیرفعال‌سازی فصل',
      () => changeStructureLifecycle('season', season.seasonNumber, undefined,
        season.lifecycleStatus === 'disabled' ? 'active' : 'disabled'),
      season.lifecycleStatus === 'disabled' ? 'button-primary' : 'button-danger');
    if (season.lifecycleStatus === 'disabled') {
      addStructureAction(seasonActions, 'حذف دائم فصل', () => permanentlyDeleteStructure('season', season.seasonNumber), 'button-danger');
    }
    card.append(seasonActions);
    const episodes = document.createElement('div');
    episodes.className = 'series-episode-list';
    for (const episode of season.episodes || []) {
      const row = document.createElement('div');
      row.className = 'series-episode-row';
      const info = document.createElement('div');
      const episodeTitle = document.createElement('strong');
      episodeTitle.textContent = episode.title || `قسمت ${episode.episodeNumber}`;
      const details = document.createElement('p');
      details.className = 'fine-print';
      const links = episode.downloadLinks || [];
      details.textContent = `قسمت ${episode.episodeNumber} · ${links.length} لینک دانلود${episode.releaseDate ? ` · ${episode.releaseDate}` : ''}`;
      info.append(episodeTitle, details);
      const episodeActions = document.createElement('div');
      episodeActions.className = 'form-actions';
      addStructureAction(episodeActions, 'ویرایش', () => openStructureEditor({
        kind: 'episode', mode: 'edit', seasonNumber: season.seasonNumber,
        episodeNumber: episode.episodeNumber, value: episode,
      }));
      addStructureAction(episodeActions, episode.lifecycleStatus === 'disabled' ? 'بازگردانی' : 'غیرفعال‌سازی',
        () => changeStructureLifecycle('episode', season.seasonNumber, episode.episodeNumber,
          episode.lifecycleStatus === 'disabled' ? 'active' : 'disabled'),
        episode.lifecycleStatus === 'disabled' ? 'button-primary' : 'button-danger');
      if (episode.lifecycleStatus === 'disabled') {
        addStructureAction(episodeActions, 'حذف دائم', () => permanentlyDeleteStructure('episode', season.seasonNumber, episode.episodeNumber), 'button-danger');
      }
      row.append(info, episodeActions);
      episodes.append(row);
    }
    if ((season.episodes || []).length === 0) {
      const empty = document.createElement('p');
      empty.className = 'fine-print';
      empty.textContent = 'قسمتی ثبت نشده است.';
      episodes.append(empty);
    }
    card.append(episodes);
    list.append(card);
  }
}

async function loadSeriesStructure() {
  if (!selectedItem || selectedItem.kind !== 'series') {
    seriesStructure = [];
    renderSeriesStructure();
    return;
  }
  try {
    const result = await api(`${API_ROOT}/items/${encodeURIComponent(selectedItem.id)}/seasons`);
    seriesStructure = result.body.data || [];
    const message = $('#series-structure-message');
    if (message) message.hidden = true;
    renderSeriesStructure();
  } catch (error) {
    seriesStructure = [];
    renderSeriesStructure();
    const message = $('#series-structure-message');
    if (message) {
      message.hidden = false;
      message.textContent = error.message || 'ساختار فصل‌ها و قسمت‌ها بارگذاری نشد.';
    }
  }
}

function addDownloadLinkEditorRow(link = {}) {
  const container = $('#structure-download-links');
  const row = document.createElement('div');
  row.className = 'structure-download-row';
  row.dataset.linkId = link.id || crypto.randomUUID();
  const label = document.createElement('input');
  label.type = 'text';
  label.maxLength = 80;
  label.placeholder = 'عنوان یا کیفیت (مثلاً 720p)';
  label.value = link.label || '';
  label.setAttribute('aria-label', 'عنوان لینک دانلود');
  const url = document.createElement('input');
  url.type = 'text';
  url.maxLength = 2000;
  url.placeholder = 'آدرس یا شناسه دانلود';
  url.value = link.url || '';
  url.setAttribute('aria-label', 'آدرس لینک دانلود');
  const size = document.createElement('input');
  size.type = 'number';
  size.min = '0';
  size.step = '1';
  size.placeholder = 'حجم (بایت)';
  size.value = link.sizeBytes == null ? '' : String(link.sizeBytes);
  size.setAttribute('aria-label', 'حجم فایل به بایت');
  const enabledLabel = document.createElement('label');
  enabledLabel.className = 'check-label';
  const enabled = document.createElement('input');
  enabled.type = 'checkbox';
  enabled.checked = link.enabled !== false;
  enabledLabel.append(enabled, document.createTextNode('فعال'));
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'button button-small button-danger';
  remove.textContent = 'حذف لینک';
  remove.addEventListener('click', () => row.remove());
  row.append(label, url, size, enabledLabel, remove);
  container.append(row);
}

function openStructureEditor({ kind, mode, seasonNumber, episodeNumber, value = {} }) {
  structureEditor = { kind, mode, seasonNumber, episodeNumber };
  setText($('#structure-editor-kind'), kind === 'season' ? 'مدیریت فصل' : 'مدیریت قسمت');
  setText($('#structure-editor-title'), `${mode === 'create' ? 'افزودن' : 'ویرایش'} ${kind === 'season' ? 'فصل' : 'قسمت'}`);
  const numberField = $('#structure-number-field');
  const numberInput = $('#structure-number');
  numberInput.value = mode === 'edit' ? String(kind === 'season' ? seasonNumber : episodeNumber) : '';
  numberInput.readOnly = mode === 'edit';
  numberField.firstChild.textContent = kind === 'season' ? 'شماره فصل' : 'شماره قسمت';
  $('#structure-title').value = value.title || '';
  $('#structure-description').value = value.description || '';
  $('#structure-release-field').hidden = kind !== 'episode';
  $('#structure-release-date').value = value.releaseDate || '';
  $('#structure-links-field').hidden = kind !== 'episode';
  $('#structure-download-links').replaceChildren();
  if (kind === 'episode') {
    const links = value.downloadLinks || [];
    if (links.length) links.forEach(addDownloadLinkEditorRow);
    else addDownloadLinkEditorRow();
  }
  $('#series-structure-editor').showModal();
}

async function saveSeriesStructure(event) {
  event.preventDefault();
  if (!selectedItem || selectedItem.kind !== 'series' || !structureEditor ||
      !hasPermission('catalog.metadata.write')) return;
  const button = $('#structure-save');
  setBusy(button, true);
  try {
    const { kind, mode, seasonNumber, episodeNumber } = structureEditor;
    const number = Number($('#structure-number').value);
    if (!Number.isSafeInteger(number) || number < 1) {
      showToast('شماره فصل یا قسمت معتبر نیست.', 'error');
      return;
    }
    const title = $('#structure-title').value.trim();
    const description = $('#structure-description').value.trim();
    const body = {
      [kind === 'season' ? 'seasonNumber' : 'episodeNumber']: number,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
    };
    let path;
    let method;
    let headers;
    if (kind === 'season') {
      path = `${API_ROOT}/items/${encodeURIComponent(selectedItem.id)}/seasons`;
      method = mode === 'create' ? 'POST' : 'PUT';
      if (mode === 'edit') {
        const current = await api(`${path}/${seasonNumber}`);
        path += `/${seasonNumber}`;
        headers = { 'If-Match': current.etag };
        delete body.seasonNumber;
      } else headers = { 'If-None-Match': '*' };
    } else {
      const base = `${API_ROOT}/items/${encodeURIComponent(selectedItem.id)}/seasons/${seasonNumber}/episodes`;
      path = mode === 'create' ? base : `${base}/${episodeNumber}`;
      method = mode === 'create' ? 'POST' : 'PUT';
      body.releaseDate = $('#structure-release-date').value || undefined;
      const links = $$('#structure-download-links .structure-download-row').map((row, index) => {
        const fields = row.querySelectorAll('input');
        const sizeBytes = fields[2].value === '' ? undefined : Number(fields[2].value);
        return {
          id: row.dataset.linkId,
          label: fields[0].value.trim(),
          url: fields[1].value.trim(),
          ...(sizeBytes === undefined ? {} : { sizeBytes }),
          sortOrder: index,
          enabled: fields[3].checked,
        };
      });
      if (!links.length || links.some((link) => !link.label || !link.url ||
          (link.sizeBytes !== undefined && (!Number.isSafeInteger(link.sizeBytes) || link.sizeBytes < 0)))) {
        showToast('برای هر قسمت حداقل یک لینک معتبر لازم است.', 'error');
        return;
      }
      body.downloadLinks = links;
      if (mode === 'edit') {
        const current = await api(path);
        headers = { 'If-Match': current.etag };
      } else headers = { 'If-None-Match': '*' };
    }
    await api(path, { method, headers, body: JSON.stringify(body) });
    $('#series-structure-editor').close();
    structureEditor = null;
    await loadSeriesStructure();
    await loadContent();
    showToast(kind === 'season' ? 'اطلاعات فصل ذخیره شد.' : 'اطلاعات قسمت ذخیره شد.', 'success');
  } catch (error) {
    if (error.status === 409) showToast('شماره فصل یا قسمت تکراری است.', 'error');
    else reportApiError(error);
  } finally {
    setBusy(button, false);
  }
}

async function changeStructureLifecycle(kind, seasonNumber, episodeNumber, lifecycleStatus) {
  const path = structureApiPath(seasonNumber, episodeNumber);
  try {
    const current = await api(path);
    const result = await api(`${path}/lifecycle`, {
      method: 'PATCH',
      headers: { 'If-Match': current.etag },
      body: JSON.stringify({ lifecycleStatus }),
    });
    await loadSeriesStructure();
    await loadContent();
    showToast(lifecycleStatus === 'disabled' ? 'مورد غیرفعال شد.' : 'مورد بازگردانی شد.', 'success');
  } catch (error) { reportApiError(error); }
}

async function permanentlyDeleteStructure(kind, seasonNumber, episodeNumber) {
  const path = structureApiPath(seasonNumber, kind === 'episode' ? episodeNumber : undefined);
  if (!window.confirm('این مورد و اطلاعات وابسته به آن برای همیشه حذف شوند؟')) return;
  try {
    const current = await api(path);
    await api(path, { method: 'DELETE', headers: { 'If-Match': current.etag } });
    await loadSeriesStructure();
    await loadContent();
    showToast('مورد حذف دائم شد.', 'success');
  } catch (error) { reportApiError(error); }
}

async function openParentSeries(item) {
  try {
    const result = await api(`${API_ROOT}/items?q=${encodeURIComponent(item.systemCode)}&lifecycleStatus=active&pageSize=100`);
    const parent = result.body.data.find((entry) => entry.id === item.parentContentId);
    if (!parent) throw new Error('سریال مادر در فهرست فعال پیدا نشد.');
    await openContent(parent);
  } catch (error) { reportApiError(error); }
}

function renderSelectedContent() {
  if (!selectedItem) return;
  setText($('#dialog-kind'), selectedItem.kind === 'movie' ? 'سینمایی' : 'سریال');
  setText($('#dialog-title'), selectedItem.title);
  setText($('#dialog-code'), selectedItem.systemCode);
  setText($('#dialog-year'), yearLabel(selectedItem));
  setText($('#dialog-approval'), STATUS_LABELS[selectedMetadata?.approvalStatus] || 'نامشخص');
  setText($('#dialog-publication'), STATUS_LABELS[selectedMetadata?.publicationStatus] || 'نامشخص');
  const series = selectedItem.seriesMetadata || {};
  $('#series-structure-panel').hidden = selectedItem.kind !== 'series';
  setText($('#dialog-series'), selectedItem.kind === 'series'
    ? `فصل و قسمت: ${series.seasonsAndEpisodes || 'ثبت نشده'}${series.isOngoing ? ' · در حال پخش' : ''}`
    : '');
  setText($('#dialog-synopsis'), selectedItem.synopsis || 'خلاصه‌ای ثبت نشده است.');
  setText($('#dialog-cast'), selectedItem.cast ? `بازیگران: ${selectedItem.cast}` : '');
  populateMultiSelect(elements.metadataCountries, countryTerms, selectedMetadata?.countryIds || []);
  populateMultiSelect(elements.metadataGenres, genreTerms, selectedMetadata?.genreIds || []);
  populateMultiSelect(elements.metadataCategories, categoryTerms, selectedMetadata?.categoryIds || []);
  permissionControls();
  if (selectedSource) renderSourceForm(selectedSource);
}

async function openContent(item, notice) {
  selectedItem = item;
  seriesStructure = [];
  selectedSource = null;
  selectedMetadata = {
    contentId: item.id,
    approvalStatus: 'pending',
    publicationStatus: 'draft',
    countryIds: [],
    genreIds: [],
  };
  selectedEtag = null;
  elements.dialogMessage.hidden = true;
  try {
    const [metadataResult, countriesResult, genresResult, categoriesResult, sourceResult] = await Promise.all([
      api(`${API_ROOT}/items/${encodeURIComponent(item.id)}/metadata`),
      api(`${API_ROOT}/taxonomies/country`),
      api(`${API_ROOT}/taxonomies/genre`),
      api(`${API_ROOT}/categories`),
      hasPermission('catalog.metadata.write') ? api(`${API_ROOT}/items/${encodeURIComponent(item.id)}/source`) : Promise.resolve(null),
    ]);
    selectedMetadata = metadataResult.body.data;
    selectedEtag = metadataResult.etag;
    countryTerms = countriesResult.body.data;
    genreTerms = genresResult.body.data;
    categoryTerms = categoriesResult.body.data;
    selectedSource = sourceResult?.body?.data || null;
  } catch (error) {
    if (error.status === 404) {
      try {
        const [countriesResult, genresResult, categoriesResult] = await Promise.all([
          api(`${API_ROOT}/taxonomies/country`), api(`${API_ROOT}/taxonomies/genre`),
          api(`${API_ROOT}/categories`),
        ]);
        countryTerms = countriesResult.body.data;
        genreTerms = genresResult.body.data;
        categoryTerms = categoriesResult.body.data;
        if (hasPermission('catalog.metadata.write')) {
          try {
            const sourceResult = await api(`${API_ROOT}/items/${encodeURIComponent(item.id)}/source`);
            selectedSource = sourceResult.body.data;
          } catch (sourceError) { reportApiError(sourceError); }
        }
      } catch (taxonomyError) { reportApiError(taxonomyError); return; }
      if (notice) setDialogMessage(notice, 'warning');
    } else { reportApiError(error); return; }
  }
  renderSelectedContent();
  elements.contentDialog.showModal();
  if (selectedItem.kind === 'series') await loadSeriesStructure();
}

async function refreshSelectedContent(message) {
  const item = selectedItem;
  if (!item) return;
  await openContent(item, message);
}

async function saveContentMetadata(event) {
  event.preventDefault();
  if (!selectedItem || !hasPermission('catalog.metadata.write')) return;
  const button = elements.metadataSave;
  const body = {
    contentId: selectedItem.id,
    approvalStatus: selectedMetadata.approvalStatus || 'pending',
    publicationStatus: selectedMetadata.publicationStatus || 'draft',
    countryIds: selectedValues(elements.metadataCountries),
    genreIds: selectedValues(elements.metadataGenres),
    categoryIds: selectedValues(elements.metadataCategories),
  };
  if (body.categoryIds.length > 20) {
    setDialogMessage('حداکثر ۲۰ دسته‌بندی مستقیم قابل انتخاب است.', 'error');
    return;
  }
  setBusy(button, true);
  try {
    const result = await api(`${API_ROOT}/items/${encodeURIComponent(selectedItem.id)}/metadata`, {
      method: 'PUT',
      headers: selectedEtag ? { 'If-Match': selectedEtag } : { 'If-None-Match': '*' },
      body: JSON.stringify(body),
    });
    selectedMetadata = result.body.data;
    selectedEtag = result.etag;
    showToast('فراداده ذخیره شد.');
    await refreshSelectedContent();
    await loadContent();
  } catch (error) {
    if (error.status === 412) {
      await refreshSelectedContent('نسخه تغییر کرده بود. دادهٔ تازه بارگذاری شد؛ تغییر خودکار انجام نشد.');
      showToast('تعارض نسخه؛ داده را بازبینی و دوباره ذخیره کنید.', 'error');
    } else reportApiError(error);
  } finally { setBusy(button, false); }
}

async function updateItemStatus(kind, value) {
  if (!selectedItem || !selectedEtag) {
    setDialogMessage('ابتدا فرادادهٔ پایه را ذخیره کنید.', 'warning');
    return;
  }
  const permission = kind === 'approval' ? 'catalog.content.approve' : 'catalog.content.publish';
  if (!hasPermission(permission)) return;
  const verb = kind === 'approval' ? 'تغییر وضعیت تأیید' : 'تغییر وضعیت انتشار';
  if (!window.confirm(`${verb} برای «${selectedItem.title}» انجام شود؟`)) return;
  const group = $(`#${kind}-actions`);
  $$('.button', group).forEach((button) => { button.disabled = true; });
  try {
    const result = await api(`${API_ROOT}/items/${encodeURIComponent(selectedItem.id)}/${kind}`, {
      method: 'PATCH',
      headers: { 'If-Match': selectedEtag },
      body: JSON.stringify({ [`${kind}Status`]: value }),
    });
    selectedMetadata = result.body.data;
    selectedEtag = result.etag;
    renderSelectedContent();
    showToast('وضعیت ذخیره شد.');
    await loadContent();
  } catch (error) {
    if (error.status === 412) {
      await refreshSelectedContent('نسخه تغییر کرده بود. رکورد تازه بارگذاری شد؛ عملیات تکرار نشد.');
      showToast('تعارض نسخه؛ وضعیت تازه را بررسی کنید.', 'error');
    } else reportApiError(error);
  } finally { $$('.button', group).forEach((button) => { button.disabled = false; }); }
}

function makeRecordButton(primary, secondary, onClick, onDelete) {
  const record = document.createElement('div');
  record.className = 'record-button';
  const details = document.createElement('div');
  details.className = 'record-details';
  const title = document.createElement('strong');
  title.textContent = primary;
  const detail = document.createElement('span');
  detail.textContent = secondary;
  details.append(title, detail);
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'button button-small button-secondary record-edit';
  edit.textContent = 'ویرایش';
  edit.addEventListener('click', onClick);
  record.append(details, edit);
  if (typeof onDelete === 'function') {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'button button-small button-danger record-delete';
    remove.textContent = 'حذف';
    remove.addEventListener('click', onDelete);
    record.append(remove);
  }
  return record;
}

async function loadCategories() {
  try {
    const { body } = await api(`${API_ROOT}/categories`);
    categoryTerms = Array.isArray(body.data) ? body.data : [];
    const list = elements.categoryList;
    list.replaceChildren();
    if (!body.data.length) {
      list.append(emptyMessage('دسته‌ای وجود ندارد. برای ساخت، دکمهٔ دستهٔ جدید را بزنید.'));
      return;
    }
    body.data.forEach((category) => {
      list.append(makeRecordButton(
        category.localizedTitle.fa || category.slug,
        `${category.slug} · ${category.enabled ? 'فعال' : 'غیرفعال'}`,
        () => void editCategory(category.id),
        () => void deleteCategory(category.id),
      ));
    });
    clearGlobalMessage();
  } catch (error) { reportApiError(error); }
}

function emptyMessage(message) {
  const paragraph = document.createElement('p');
  paragraph.className = 'empty-message';
  paragraph.textContent = message;
  return paragraph;
}

function clearCategoryForm() {
  elements.categoryForm.reset();
  selectedCategory = { id: null, etag: null };
  $('#category-id').disabled = false;
  $('#category-form-title').textContent = 'دستهٔ جدید';
  $('#category-enabled').checked = true;
  $('#category-sort').value = '0';
  $('#category-mode').value = 'dynamic';
  $('#filter-conditions').replaceChildren();
  $('#category-other-titles').replaceChildren();
  $('#category-filter-json').value = '';
  $('#category-advanced').hidden = true;
  $('#category-filter-warning').hidden = true;
}

function addLocalizedTitle(locale = '', title = '') {
  const row = document.createElement('div');
  row.className = 'localized-row';
  const localeInput = document.createElement('input');
  localeInput.value = locale;
  localeInput.maxLength = 5;
  localeInput.pattern = '[a-z]{2}(-[A-Z]{2})?';
  localeInput.placeholder = 'مثلاً tr یا en-US';
  localeInput.dir = 'ltr';
  localeInput.setAttribute('aria-label', 'کد زبان');
  const titleInput = document.createElement('input');
  titleInput.value = title;
  titleInput.maxLength = 160;
  titleInput.placeholder = 'عنوان ترجمه‌شده';
  titleInput.setAttribute('aria-label', 'عنوان ترجمه‌شده');
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'icon-button';
  remove.textContent = '×';
  remove.setAttribute('aria-label', 'حذف ترجمه');
  remove.addEventListener('click', () => row.remove());
  row.append(localeInput, titleInput, remove);
  $('#category-other-titles').append(row);
  return row;
}

function openNewCategory() {
  clearCategoryForm();
  elements.categoryForm.hidden = false;
  void loadTaxonomyOptions();
}

async function editCategory(id) {
  try {
    const result = await api(`${API_ROOT}/categories/${encodeURIComponent(id)}`);
    const category = result.body.data;
    selectedCategory = { id, etag: result.etag };
    elements.categoryForm.reset();
    elements.categoryForm.hidden = false;
    $('#category-id').value = id;
    $('#category-id').disabled = true;
    $('#category-title-fa').value = category.localizedTitle.fa || '';
    $('#category-title-en').value = category.localizedTitle.en || '';
    $('#category-other-titles').replaceChildren();
    Object.entries(category.localizedTitle)
      .filter(([locale]) => !['fa', 'en'].includes(locale))
      .forEach(([locale, title]) => addLocalizedTitle(locale, title));
    $('#category-slug').value = category.slug;
    $('#category-sort').value = String(category.sortOrder ?? 0);
    $('#category-mode').value = category.mode || 'dynamic';
    $('#category-enabled').checked = category.enabled;
    $('#category-form-title').textContent = `ویرایش ${category.localizedTitle.fa || category.slug}`;
    await loadTaxonomyOptions();
    if (category.filters) setCategoryFilter(category.filters);
  } catch (error) { reportApiError(error); }
}

async function loadTaxonomyOptions() {
  try {
    const [countries, genres] = await Promise.all([
      api(`${API_ROOT}/taxonomies/country`), api(`${API_ROOT}/taxonomies/genre`),
    ]);
    countryTerms = countries.body.data;
    genreTerms = genres.body.data;
  } catch (error) { reportApiError(error); }
}

function addFilterCondition(condition = {}) {
  const row = document.createElement('div');
  row.className = 'filter-row';
  const field = document.createElement('select');
  field.setAttribute('aria-label', 'فیلد فیلتر');
  [['kind', 'نوع محتوا'], ['countryIds', 'کشور'], ['genreIds', 'ژانر'], ['releaseYear', 'سال انتشار']]
    .forEach(([value, label]) => field.add(new Option(label, value)));
  field.value = condition.field || 'kind';
  const operator = document.createElement('select');
  operator.setAttribute('aria-label', 'عملگر فیلتر');
  const value = document.createElement('select');
  value.setAttribute('aria-label', 'مقدار فیلتر');
  const number = document.createElement('input');
  number.type = 'number';
  number.min = '1800';
  number.max = '3000';
  number.placeholder = 'سال';
  number.setAttribute('aria-label', 'سال فیلتر');
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'icon-button';
  remove.textContent = '×';
  remove.setAttribute('aria-label', 'حذف شرط');
  remove.addEventListener('click', () => row.remove());

  function refreshOptions() {
    operator.replaceChildren();
    value.replaceChildren();
    const options = field.value === 'kind'
      ? [['eq', '=']]
      : field.value === 'countryIds' || field.value === 'genreIds'
        ? [['contains', 'شامل']]
        : [['eq', '='], ['gte', 'بزرگ‌تر/مساوی'], ['lte', 'کوچک‌تر/مساوی']];
    options.forEach(([v, label]) => operator.add(new Option(label, v)));
    if (field.value === 'kind') {
      value.add(new Option('سینمایی', 'movie'));
      value.add(new Option('سریال', 'series'));
    } else if (field.value === 'countryIds' || field.value === 'genreIds') {
      const terms = field.value === 'countryIds' ? countryTerms : genreTerms;
      terms.filter((term) => term.enabled).forEach((term) => value.add(new Option(term.labelFa, term.id)));
    }
    value.hidden = field.value === 'releaseYear';
    number.hidden = field.value !== 'releaseYear';
    operator.value = condition.op || operator.options[0]?.value;
    if (field.value === 'releaseYear') number.value = condition.value ?? '';
    else if (condition.value !== undefined) value.value = String(condition.value);
  }
  field.addEventListener('change', () => { condition = {}; refreshOptions(); });
  refreshOptions();
  row.append(field, operator, value, number, remove);
  row.readCondition = () => ({
    field: field.value,
    op: operator.value,
    value: field.value === 'releaseYear' ? Number(number.value) : value.value,
  });
  $('#filter-conditions').append(row);
}

function getSimpleConditions(filter) {
  if (!filter) return [];
  const expressions = Array.isArray(filter.all) && Object.keys(filter).length === 1 ? filter.all : [filter];
  if (expressions.some((item) => !item || typeof item !== 'object' || Array.isArray(item) ||
      Object.hasOwn(item, 'all') || Object.hasOwn(item, 'any'))) return null;
  return expressions;
}

function setCategoryFilter(filter) {
  const conditions = getSimpleConditions(filter);
  $('#filter-conditions').replaceChildren();
  if (conditions) {
    conditions.forEach((condition) => addFilterCondition(condition));
    return;
  }
  $('#category-advanced').hidden = false;
  $('#category-filter-warning').hidden = false;
  $('#category-filter-json').value = JSON.stringify(filter, null, 2);
}

function categoryFilters() {
  if (!$('#category-advanced').hidden) {
    const value = JSON.parse($('#category-filter-json').value);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('فیلتر JSON باید یک شیء باشد.');
    return value;
  }
  const conditions = $$('.filter-row', $('#filter-conditions')).map((row) => row.readCondition());
  if (conditions.some((item) => item.field === 'releaseYear' && !Number.isInteger(item.value))) {
    throw new Error('سال فیلتر را وارد کنید.');
  }
  return conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : { all: conditions };
}

async function saveCategory(event) {
  event.preventDefault();
  if (!hasPermission('catalog.categories.manage')) return;
  const id = $('#category-id').value.trim();
  const localizedTitle = { fa: $('#category-title-fa').value.trim() };
  if ($('#category-title-en').value.trim()) localizedTitle.en = $('#category-title-en').value.trim();
  const otherTitles = $$('.localized-row', $('#category-other-titles'));
  for (const row of otherTitles) {
    const locale = $('input[aria-label="کد زبان"]', row).value.trim();
    const title = $('input[aria-label="عنوان ترجمه‌شده"]', row).value.trim();
    if (!/^[a-z]{2}(?:-[A-Z]{2})?$/.test(locale) || !title || Object.hasOwn(localizedTitle, locale)) {
      setGlobalMessage('کد زبان باید یکتا و از قالب دوحرفی مجاز پیروی کند و عنوان خالی نباشد.');
      return;
    }
    localizedTitle[locale] = title;
  }
  const body = {
    slug: $('#category-slug').value.trim(),
    localizedTitle,
    enabled: $('#category-enabled').checked,
    sortOrder: Number($('#category-sort').value),
    mode: $('#category-mode').value,
  };
  try {
    const filters = categoryFilters();
    if (filters !== undefined) body.filters = filters;
  } catch (error) {
    setGlobalMessage(error.message);
    return;
  }
  const button = $('button[type="submit"]', elements.categoryForm);
  setBusy(button, true);
  try {
    await api(`${API_ROOT}/categories/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: selectedCategory.etag ? { 'If-Match': selectedCategory.etag } : { 'If-None-Match': '*' },
      body: JSON.stringify(body),
    });
    elements.categoryForm.hidden = true;
    await loadCategories();
    showToast('دسته‌بندی ذخیره شد.');
  } catch (error) {
    if (error.status === 412) {
      showToast('تعارض نسخه؛ دسته را دوباره باز و بررسی کنید.', 'error');
      await loadCategories();
    } else reportApiError(error);
  } finally { setBusy(button, false); }
}

async function deleteCategory(id) {
  if (!hasPermission('catalog.categories.manage')) return;
  if (!window.confirm(`دسته‌بندی «${id}» برای همیشه حذف شود؟ اگر به محتوایی اختصاص داشته باشد، حذف انجام نمی‌شود.`)) return;
  try {
    const current = await api(`${API_ROOT}/categories/${encodeURIComponent(id)}`);
    await api(`${API_ROOT}/categories/${encodeURIComponent(id)}`, {
      method: 'DELETE', headers: { 'If-Match': current.etag },
    });
    elements.categoryForm.hidden = true;
    await loadCategories();
    showToast('دسته‌بندی حذف شد.');
  } catch (error) {
    if (error.status === 409) showToast('این دسته‌بندی هنوز به محتوا متصل است و حذف نشد.', 'error');
    else if (error.status === 412) showToast('دسته‌بندی هم‌زمان تغییر کرده؛ فهرست را تازه‌سازی کنید.', 'error');
    else reportApiError(error);
  }
}

async function loadTaxonomy(type) {
  const list = type === 'country' ? elements.countryList : elements.genreList;
  try {
    const { body } = await api(`${API_ROOT}/taxonomies/${type}`);
    if (type === 'country') countryTerms = body.data;
    else genreTerms = body.data;
    list.replaceChildren();
    if (!body.data.length) list.append(emptyMessage('موردی ثبت نشده است. برای افزودن، دکمهٔ جدید را بزنید.'));
    body.data.forEach((term) => list.append(makeRecordButton(
      term.labelFa,
      `${term.id} · ${term.enabled ? 'فعال' : 'غیرفعال'}`,
      () => void editTaxonomy(type, term.id),
      () => void deleteTaxonomy(type, term.id),
    )));
    clearGlobalMessage();
  } catch (error) { reportApiError(error); }
}

async function deleteTaxonomy(type, id) {
  if (!hasPermission('catalog.taxonomies.manage')) return;
  const label = type === 'country' ? 'کشور' : 'ژانر';
  if (!window.confirm(`${label} «${id}» برای همیشه حذف شود؟ اگر در فرادادهٔ محتوایی استفاده شده باشد، حذف انجام نمی‌شود.`)) return;
  try {
    const current = await api(`${API_ROOT}/taxonomies/${type}/${encodeURIComponent(id)}`);
    await api(`${API_ROOT}/taxonomies/${type}/${encodeURIComponent(id)}`, {
      method: 'DELETE', headers: { 'If-Match': current.etag },
    });
    taxonomyElements(type).form.hidden = true;
    await loadTaxonomy(type);
    showToast(`${label} حذف شد.`);
  } catch (error) {
    if (error.status === 409) showToast(`این ${label} هنوز در اطلاعات محتوا استفاده می‌شود و حذف نشد.`, 'error');
    else if (error.status === 412) showToast(`${label} هم‌زمان تغییر کرده؛ فهرست را تازه‌سازی کنید.`, 'error');
    else reportApiError(error);
  }
}

function taxonomyElements(type) {
  const prefix = type === 'country' ? 'country' : 'genre';
  return {
    form: elements[`${prefix}Form`],
    id: $(`#${prefix}-id`),
    label: $(`#${prefix}-label`),
    sort: $(`#${prefix}-sort`),
    enabled: $(`#${prefix}-enabled`),
    title: $(`#${prefix}-form-title`),
  };
}

function newTaxonomy(type) {
  const ui = taxonomyElements(type);
  ui.form.reset();
  ui.form.hidden = false;
  selectedTaxonomy = { type, id: null, etag: null };
  ui.id.disabled = false;
  ui.title.textContent = type === 'country' ? 'کشور جدید' : 'ژانر جدید';
  ui.sort.value = '0';
  ui.enabled.checked = true;
}

async function editTaxonomy(type, id) {
  try {
    const result = await api(`${API_ROOT}/taxonomies/${type}/${encodeURIComponent(id)}`);
    const term = result.body.data;
    const ui = taxonomyElements(type);
    selectedTaxonomy = { type, id, etag: result.etag };
    ui.form.hidden = false;
    ui.id.value = id;
    ui.id.disabled = true;
    ui.label.value = term.labelFa;
    ui.sort.value = String(term.sortOrder ?? 0);
    ui.enabled.checked = term.enabled;
    ui.title.textContent = `ویرایش ${term.labelFa}`;
  } catch (error) { reportApiError(error); }
}

async function saveTaxonomy(event, type) {
  event.preventDefault();
  if (!hasPermission('catalog.taxonomies.manage')) return;
  const ui = taxonomyElements(type);
  const id = ui.id.value.trim();
  const body = {
    labelFa: ui.label.value.trim(),
    enabled: ui.enabled.checked,
    sortOrder: Number(ui.sort.value),
  };
  const button = $('button[type="submit"]', ui.form);
  setBusy(button, true);
  try {
    await api(`${API_ROOT}/taxonomies/${type}/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: selectedTaxonomy.etag ? { 'If-Match': selectedTaxonomy.etag } : { 'If-None-Match': '*' },
      body: JSON.stringify(body),
    });
    ui.form.hidden = true;
    await loadTaxonomy(type);
    showToast(type === 'country' ? 'کشور ذخیره شد.' : 'ژانر ذخیره شد.');
  } catch (error) {
    if (error.status === 412) {
      showToast('تعارض نسخه؛ رکورد تازه را بازبینی کنید.', 'error');
      await loadTaxonomy(type);
    } else reportApiError(error);
  } finally { setBusy(button, false); }
}

function renderAudit(events) {
  elements.auditRows.replaceChildren();
  events.forEach((event) => {
    const row = document.createElement('tr');
    const values = [
      new Date(event.occurredAt).toLocaleString('fa-IR'),
      event.operation,
      event.entityType,
      event.entityId,
      event.actorId || '—',
      `${event.previousVersion} ← ${event.version}`,
      event.changedFields.join('، '),
    ];
    values.forEach((value, index) => {
      const cell = document.createElement('td');
      if (index === 3 || index === 4) cell.className = 'mono';
      cell.textContent = String(value);
      row.append(cell);
    });
    elements.auditRows.append(row);
  });
  if (!events.length) elements.auditRows.append(emptyRow('رویدادی برای نمایش وجود ندارد.'));
}

function emptyRow(message) {
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.colSpan = 7;
  cell.className = 'empty-message';
  cell.textContent = message;
  row.append(cell);
  return row;
}

async function loadAudit() {
  try {
    const { body } = await api(`${API_ROOT}/audit?page=${auditPage}&pageSize=20`);
    renderAudit(body.data);
    auditHasMore = body.meta.hasMore;
    setText(elements.auditPage, `صفحهٔ ${auditPage.toLocaleString('fa-IR')}`);
    elements.auditPrev.disabled = auditPage <= 1;
    elements.auditNext.disabled = !auditHasMore;
    clearGlobalMessage();
  } catch (error) { reportApiError(error); }
}

function renderSession(user, data) {
  currentUser = user;
  session = data;
  showDashboard();
  selectView('overview');
  void loadManagers({ probe: true });
}

async function handleAuthState(user) {
  authSessionCoordinator.transition(user);
}

authSessionCoordinator = createAuthSessionCoordinator({
  loadSession: async ({ signal }) => {
    const { body } = await api(`${API_ROOT}/me`, { signal });
    return body.data;
  },
  onAuthenticated: (user) => {
    currentUser = user;
    session = null;
    managerEmailById.clear();
  },
  onUnauthenticated: () => {
    currentUser = null;
    session = null;
    managerEmailById.clear();
    setManagerAccessVisible(false);
    showLogin();
  },
  onSession: (user, data) => renderSession(user, data),
  onError: (error, user) => {
    if (error.status === 403) {
      session = null;
      managerEmailById.clear();
      setManagerAccessVisible(false);
      showNoAccess(user);
      return;
    }
    if (error.status === 401) {
      session = null;
      managerEmailById.clear();
      setManagerAccessVisible(false);
      void signOutCurrentUser?.();
      showLogin('نشست Firebase معتبر نیست؛ دوباره وارد شوید.');
      return;
    }
    elements.bootScreen.hidden = true;
    elements.loginScreen.hidden = true;
    elements.noAccessScreen.hidden = true;
    elements.dashboard.hidden = false;
    setGlobalMessage(error.message || 'بررسی دسترسی در دسترس نیست.', { requestId: error.requestId });
    setText($('#top-email'), user.email || 'ایمیل در دسترس نیست');
    $$('.nav-item').forEach((item) => { item.hidden = true; });
  },
});

async function startFirebase() {
  elements.bootMessage.textContent = 'پیکربندی Firebase دریافت می‌شود…';
  elements.missingConfig.hidden = true;
  elements.bootRetry.hidden = true;
  try {
    const response = await fetch('/admin/config.json', { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok || !payload?.data) {
      const missing = payload?.error?.missing || [];
      elements.bootMessage.textContent = payload?.error?.message || 'پیکربندی Firebase پنل در دسترس نیست.';
      elements.missingConfig.replaceChildren();
      missing.forEach((name) => {
        const item = document.createElement('li');
        item.textContent = name;
        elements.missingConfig.append(item);
      });
      elements.missingConfig.hidden = missing.length === 0;
      elements.bootRetry.hidden = false;
      return;
    }
    firebaseConfig = payload.data;
    const [appModule, authModule] = await Promise.all([
      import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app.js`),
      import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-auth.js`),
    ]);
    const app = appModule.initializeApp(firebaseConfig);
    // Do not restore a browser-persistent Firebase session. Auth state is kept
    // only in memory and must be re-established after a page reload.
    auth = authModule.initializeAuth(app, {
      persistence: authModule.inMemoryPersistence,
      popupRedirectResolver: authModule.browserPopupRedirectResolver,
    });
    signOutCurrentUser = () => {
      authSessionCoordinator.invalidate();
      return authModule.signOut(auth);
    };
    authModule.onAuthStateChanged(auth, (user) => { void handleAuthState(user); });
    $('#sign-in').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      setBusy(button, true);
      setText(elements.loginMessage, 'در حال بازکردن ورود Google…');
      try {
        await authModule.signInWithPopup(auth, new authModule.GoogleAuthProvider());
      } catch (error) {
        const messages = {
          'auth/popup-blocked': 'مرورگر پنجره ورود را مسدود کرد.',
          'auth/popup-closed-by-user': 'پنجره ورود بسته شد؛ دوباره تلاش کنید.',
          'auth/unauthorized-domain': 'دامنهٔ این سرویس در Firebase مجاز نشده است.',
          'auth/operation-not-allowed': 'ورود Google در Firebase فعال نشده است.',
        };
        setText(elements.loginMessage, messages[error?.code] || 'ورود انجام نشد؛ تنظیمات Authentication را بررسی کنید.');
      } finally { setBusy(button, false); }
    });
    $('#sign-out').addEventListener('click', () => void signOutCurrentUser());
    $('#no-access-sign-out').addEventListener('click', () => void signOutCurrentUser());
  } catch {
    elements.bootMessage.textContent = 'راه‌اندازی Firebase انجام نشد؛ تنظیمات Web App و دسترسی مرورگر را بررسی کنید.';
    elements.bootRetry.hidden = false;
  }
}

function wireUi() {
  elements.bootRetry.addEventListener('click', () => void startFirebase());
  $$('[data-settings-view]').forEach((button) => button.addEventListener('click', () => {
    const target = button.dataset.settingsView;
    $$('.settings-pane').forEach((pane) => { pane.hidden = pane.id !== `settings-${target}`; });
    if (target === 'countries') void loadTaxonomy('country');
    if (target === 'genres') void loadTaxonomy('genre');
    if (target === 'categories') void loadCategories();
  }));
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => selectView(button.dataset.view, button.dataset.kind)));
  $$('.refresh-button').forEach((button) => button.addEventListener('click', () => {
    const action = button.dataset.refresh;
    if (action === 'overview') void loadOverview();
    else if (action === 'content') void loadContent();
    else if (action === 'categories') void loadCategories();
    else if (action === 'countries') void loadTaxonomy('country');
    else if (action === 'genres') void loadTaxonomy('genre');
    else if (action === 'audit') void loadAudit();
    else if (action === 'managers') void loadManagers();
  }));
  elements.managerNew.addEventListener('click', () => {
    elements.managerForm.hidden = false;
    if (!managerAccessAllowed) setManagerMessage('فرم آماده است؛ ثبت مدیر پس از تأیید مالک فعال می‌شود.');
    elements.managerEmail.focus();
  });
  elements.managerRefresh.addEventListener('click', () => void loadManagers());
  elements.managerCancel.addEventListener('click', () => { elements.managerForm.hidden = true; });
  $$('[data-manager-cancel]').forEach((button) => button.addEventListener('click', () => {
    elements.managerForm.hidden = true;
  }));
  elements.managerForm.addEventListener('submit', (event) => void addManager(event));
  $('#content-select-all').addEventListener('change', (event) => {
    currentItems.filter((item) => item.kind === 'movie' || item.kind === 'series').forEach((item) => {
      if (event.currentTarget.checked && contentLifecycleStatus === 'active') selectedContentIds.add(item.id);
      else selectedContentIds.delete(item.id);
    });
    renderContentRows(currentItems);
    updateBulkControls();
  });
  $('#bulk-approve').addEventListener('click', () => void runBulkStatus('approval', 'approved'));
  $('#bulk-publish').addEventListener('click', () => void runBulkStatus('publication', 'published'));
  $('#content-clear-selection').addEventListener('click', () => {
    selectedContentIds.clear();
    renderContentRows(currentItems);
    updateBulkControls();
  });
  $('[data-lifecycle-view]').forEach((button) => button.addEventListener('click', () => {
    contentLifecycleStatus = button.dataset.lifecycleView;
    contentPage = 1;
    selectedContentIds.clear();
    $('[data-lifecycle-view]').forEach((tab) => {
      const active = tab.dataset.lifecycleView === contentLifecycleStatus;
      tab.classList.toggle('button-primary', active);
      tab.classList.toggle('button-secondary', !active);
      tab.setAttribute('aria-pressed', String(active));
    });
    void loadContent();
  }));
  $('#content-search-button').addEventListener('click', () => { contentPage = 1; void loadContent(); });
  $('#content-filter-reset').addEventListener('click', () => {
    [elements.contentSearch, elements.contentApproval, elements.contentPublication, elements.contentCountry, elements.contentGenre, elements.contentCategory].forEach((control) => { control.value = ''; });
    contentPage = 1;
    void loadContent();
  });
  elements.contentSearch.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { contentPage = 1; void loadContent(); }
  });
  [elements.contentKind, elements.contentApproval, elements.contentPublication, elements.contentCountry, elements.contentGenre, elements.contentCategory].forEach((select) => {
    select.addEventListener('change', () => { contentPage = 1; void loadContent(); });
  });
  elements.contentPrev.addEventListener('click', () => { if (contentPage > 1) { contentPage -= 1; void loadContent(); } });
  elements.contentNext.addEventListener('click', () => { if (contentPage * 20 < contentTotal) { contentPage += 1; void loadContent(); } });
  $('#dialog-close').addEventListener('click', () => elements.contentDialog.close());
  elements.contentDialog.addEventListener('click', (event) => {
    if (event.target === elements.contentDialog) elements.contentDialog.close();
  });
  elements.metadataForm.addEventListener('submit', (event) => void saveContentMetadata(event));
  $('#source-form').addEventListener('submit', (event) => void saveSourceItem(event));
  $('#source-create-form').addEventListener('submit', (event) => void createSourceItem(event));
  $('#source-create-close').addEventListener('click', () => $('#source-create-dialog').close());
  $('#content-new-movie').addEventListener('click', () => void openSourceCreate('movie'));
  $('#content-new-series').addEventListener('click', () => void openSourceCreate('series'));
  $$('[data-approval]').forEach((button) => button.addEventListener('click', () => void updateItemStatus('approval', button.dataset.approval)));
  $$('[data-publication]').forEach((button) => button.addEventListener('click', () => void updateItemStatus('publication', button.dataset.publication)));
  $('#category-new').addEventListener('click', openNewCategory);
  $('#category-form').addEventListener('submit', (event) => void saveCategory(event));
  $('#add-filter').addEventListener('click', () => addFilterCondition());
  $('#add-localized-title').addEventListener('click', () => addLocalizedTitle());
  $$('.taxonomy-new').forEach((button) => button.addEventListener('click', () => newTaxonomy(button.dataset.type)));
  elements.countryForm.addEventListener('submit', (event) => void saveTaxonomy(event, 'country'));
  elements.genreForm.addEventListener('submit', (event) => void saveTaxonomy(event, 'genre'));
  $$('[data-close-form]').forEach((button) => button.addEventListener('click', () => {
    if (button.dataset.closeForm === 'category') elements.categoryForm.hidden = true;
    if (button.dataset.closeForm === 'country') elements.countryForm.hidden = true;
    if (button.dataset.closeForm === 'genre') elements.genreForm.hidden = true;
  }));
  elements.auditPrev.addEventListener('click', () => { if (auditPage > 1) { auditPage -= 1; void loadAudit(); } });
  elements.auditNext.addEventListener('click', () => { if (auditHasMore) { auditPage += 1; void loadAudit(); } });
}

wireUi();
void startFirebase();
