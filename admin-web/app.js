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
});

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const elements = Object.fromEntries([
  'bootScreen', 'bootMessage', 'missingConfig', 'bootRetry', 'loginScreen', 'loginMessage',
  'noAccessScreen', 'noAccessMessage', 'noAccessEmail', 'noAccessUid', 'dashboard',
  'globalMessage', 'contentRows', 'contentCount', 'contentPage', 'contentPrev', 'contentNext',
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
let auditPage = 1;
let contentTotal = 0;
let auditHasMore = false;
let contentStats = null;
let contentFilterOptionsLoaded = false;
let currentItems = [];
const selectedContentIds = new Set();
let selectedItem = null;
let selectedMetadata = null;
let selectedEtag = null;
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
    ALREADY_EXISTS: 'شناسه از قبل وجود دارد.',
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
    checkbox.checked = selectedContentIds.has(item.id);
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
    kind.textContent = item.kind === 'movie' ? 'سینمایی' : 'سریال';
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
    open.textContent = 'مدیریت';
    open.addEventListener('click', () => void openContent(item));
    action.append(open);
    row.append(selection, title, kind, code, year, approval, publication, metadata, action);
    elements.contentRows.append(row);
  });
}

function updateBulkControls() {
  const count = selectedContentIds.size;
  const bar = $('#content-bulk-actions');
  if (bar) bar.hidden = count === 0;
  setText($('#content-selected-count'), `${count.toLocaleString('fa-IR')} مورد انتخاب شده`);
  const all = $('#content-select-all');
  if (all) {
    const visible = currentItems.map((item) => item.id);
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

function renderSourceForm(item) {
  $('#source-title').value = item.title || '';
  $('#source-release-year').value = item.releaseYear ?? '';
  $('#source-start-year').value = item.seriesMetadata?.startYear ?? '';
  $('#source-end-year').value = item.seriesMetadata?.isOngoing ? 'در حال پخش' : (item.seriesMetadata?.endYear ?? '');
  $('#source-seasons').value = item.seriesMetadata?.seasonsAndEpisodes ?? '';
  $('#source-synopsis').value = item.synopsis || '';
  $('#source-cast').value = item.cast || '';
  $('#source-language').value = item.language || '';
  $('#source-rating').value = item.rating || '';
  $('#source-trailer').value = item.trailerUrl || '';
  $('#source-poster').value = item.posterUrl || '';
  const available = new Set(item.sourceAvailableFields || []);
  const labels = { title: 'source-title', releaseYear: 'source-release-year-label', startYear: 'source-start-year-label',
    endYear: 'source-end-year-label', seasonsAndEpisodes: 'source-seasons-label', synopsis: 'source-synopsis',
    cast: 'source-cast', language: 'source-language', rating: 'source-rating', trailerUrl: 'source-trailer', posterUrl: 'source-poster' };
  Object.entries(labels).forEach(([field, id]) => { const control = $('#'+id); const label = control.tagName === 'LABEL' ? control : control.closest('label'); if (label) label.hidden = !available.has(field); });
  $('#source-form').hidden = !hasPermission('catalog.metadata.write');
}

async function saveSourceItem(event) {
  event.preventDefault();
  if (!selectedItem || !hasPermission('catalog.metadata.write')) return;
  const available = new Set(selectedItem.sourceAvailableFields || []);
  const candidates = {
    title: $('#source-title').value.trim(), synopsis: $('#source-synopsis').value,
    cast: $('#source-cast').value, language: $('#source-language').value.trim(),
    rating: $('#source-rating').value.trim(), trailerUrl: $('#source-trailer').value.trim(),
    posterUrl: $('#source-poster').value.trim(),
  };
  const fields = Object.fromEntries(Object.entries(candidates).filter(([key]) => available.has(key)));
  if (selectedItem.kind === 'movie') {
    if (available.has('releaseYear')) fields.releaseYear = $('#source-release-year').value === '' ? '' : Number($('#source-release-year').value);
  } else {
    if (available.has('startYear')) fields.startYear = $('#source-start-year').value === '' ? '' : Number($('#source-start-year').value);
    if (available.has('endYear')) fields.endYear = $('#source-end-year').value.trim();
    if (available.has('seasonsAndEpisodes')) fields.seasonsAndEpisodes = $('#source-seasons').value.trim();
  }
  const button = $('#source-save');
  setBusy(button, true);
  try {
    const result = await api(API_ROOT + '/items/' + encodeURIComponent(selectedItem.id) + '/source', {
      method: 'PUT', body: JSON.stringify({ sourceVersion: selectedItem.sourceVersion, fields }),
    });
    selectedItem = result.body.data;
    renderSelectedContent();
    renderSourceForm(selectedItem);
    await loadContent();
    showToast('اطلاعات اصلی در Google Sheets ذخیره شد.');
  } catch (error) {
    if (error.status === 412) {
      await refreshSelectedContent('ردیف در Google Sheets تغییر کرده است؛ اطلاعات تازه بارگذاری شد و تغییر شما ذخیره نشد.');
      showToast('تعارض نسخه؛ اطلاعات را بازبینی و دوباره ذخیره کنید.', 'error');
    } else reportApiError(error);
  } finally { setBusy(button, false); }
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
  setText($('#dialog-series'), selectedItem.kind === 'series'
    ? `فصل و قسمت: ${series.seasonsAndEpisodes || 'ثبت نشده'}${series.isOngoing ? ' · در حال پخش' : ''}`
    : '');
  setText($('#dialog-synopsis'), selectedItem.synopsis || 'خلاصه‌ای ثبت نشده است.');
  setText($('#dialog-cast'), selectedItem.cast ? `بازیگران: ${selectedItem.cast}` : '');
  populateMultiSelect(elements.metadataCountries, countryTerms, selectedMetadata?.countryIds || []);
  populateMultiSelect(elements.metadataGenres, genreTerms, selectedMetadata?.genreIds || []);
  populateMultiSelect(elements.metadataCategories, categoryTerms, selectedMetadata?.categoryIds || []);
  permissionControls();
  renderSourceForm(selectedItem);
}

async function openContent(item, notice) {
  selectedItem = item;
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
    const [metadataResult, countriesResult, genresResult, categoriesResult] = await Promise.all([
      api(`${API_ROOT}/items/${encodeURIComponent(item.id)}/metadata`),
      api(`${API_ROOT}/taxonomies/country`),
      api(`${API_ROOT}/taxonomies/genre`),
      api(`${API_ROOT}/categories`),
    ]);
    selectedMetadata = metadataResult.body.data;
    selectedEtag = metadataResult.etag;
    countryTerms = countriesResult.body.data;
    genreTerms = genresResult.body.data;
    categoryTerms = categoriesResult.body.data;
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
      } catch (taxonomyError) { reportApiError(taxonomyError); return; }
      if (notice) setDialogMessage(notice, 'warning');
    } else { reportApiError(error); return; }
  }
  renderSelectedContent();
  elements.contentDialog.showModal();
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

function makeRecordButton(primary, secondary, onClick) {
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
    )));
    clearGlobalMessage();
  } catch (error) { reportApiError(error); }
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
    currentItems.forEach((item) => {
      if (event.currentTarget.checked) selectedContentIds.add(item.id);
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
