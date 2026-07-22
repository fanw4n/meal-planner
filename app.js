import { RECIPE_FILTERS, SLOT_LABELS, recipeMap as builtinRecipeMap, recipes as builtinRecipes } from "./data.js?v=design7-20260722";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./supabase-config.js?v=sync4-20260722";

const STORAGE_KEY = "meal-planner-state-v1";
const PERSON_LABELS = { me: "Мася", alina: "Кися", both: "Вместе" };
const PERSON_SHORT_LABELS = { me: "Мася", alina: "Кися", both: "Вместе" };
const TIME_FILTERS = [
  { value: "quick", label: "На скорую руку" },
  { value: "steady", label: "В спокойном темпе" },
  { value: "slow", label: "Долгая магия" },
];
const KIND_CLASSES = { "Основное": "main", "Закуска": "snack", "Выпечка": "baking", "Суп": "soup", "Салат": "salad", "Перекус": "snack", "Каша": "porridge", "Завтрак": "breakfast", "Запеканка": "bake", "Лепёшка": "flatbread" };
const SLOT_ORDER = ["breakfast", "lunch", "dinner", "lateSnack"];
const CATEGORY_ORDER = ["Мясо", "Рыба", "Морепродукты", "Яйца", "Молочные", "Овощи", "Зелень", "Фрукты", "Заморозка", "Бакалея", "Соусы", "Специи", "Орехи", "Семена"];

const $ = (id) => document.getElementById(id);

const state = loadState();
const RECIPE_KIND_OPTIONS = ["Основное", "Закуска", "Выпечка", "Суп", "Салат", "Перекус", "Каша", "Завтрак", "Запеканка", "Лепёшка"];
const RECIPE_STORAGE_OPTIONS = [
  { value: "fresh", label: "Свежее" },
  { value: "chilled", label: "Охлаждённое" },
  { value: "frozen", label: "Заморозка" },
  { value: "dry", label: "Бакалея" },
];
const baseRecipes = builtinRecipes;
const baseRecipeMap = builtinRecipeMap;
let toastTimer;
let supabase = null;
let supabaseUser = null;
let syncTimer = null;
let syncInFlight = false;
let syncQueued = false;
let authPromptShown = false;

let lastSessionUserId = null;


function recipeCatalog() {
  return [...baseRecipes, ...(state.customRecipes || [])];
}

function recipeById(recipeId) {
  return baseRecipeMap[recipeId] || (state.customRecipes || []).find((recipe) => recipe.id === recipeId) || null;
}

function setStorageStatus(message) {
  const element = $("storageStatus");
  if (element) element.textContent = message;
}

function setAuthMessage(message, tone = "") {
  const element = $("authMessage");
  if (!element) return;
  element.textContent = message;
  element.className = `auth-message${tone ? ` is-${tone}` : ""}`;
}

function updateAuthControls() {
  const button = $("authButton");
  if (!button) return;
  if (supabaseUser) {
    button.textContent = "Выйти";
    button.classList.add("is-signed-in");
    button.setAttribute("aria-label", "Выйти из аккаунта");
  } else {
    button.textContent = "Войти";
    button.classList.remove("is-signed-in");
    button.setAttribute("aria-label", "Войти для синхронизации");
  }
}

function authRedirectUrl() {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  return url.toString();
}

function openAuthModal() {
  if (supabaseUser) {
    void signOut();
    return;
  }
  authPromptShown = true;
  $("authModal").hidden = false;
  $("authEmail").focus();
  setAuthMessage(supabase ? "Введи email — отправлю одноразовую ссылку для входа." : "Подключаю синхронизацию…");
}

function closeAuthModal() {
  $("authModal").hidden = true;
  setAuthMessage("");
}

function maybeOpenAuthPrompt() {
  if (authPromptShown || supabaseUser || !supabase) return;
  authPromptShown = true;
  window.setTimeout(() => {
    if (!supabaseUser && $("authModal").hidden) openAuthModal();
  }, 350);
}

async function sendMagicLink(event) {
  event.preventDefault();
  const email = $("authEmail").value.trim();
  if (!email) return;
  if (!supabase) {
    setAuthMessage("Supabase ещё подключается. Попробуй через секунду.", "error");
    return;
  }
  const submit = $("authSubmit");
  submit.disabled = true;
  setAuthMessage("Отправляю ссылку на почту…");
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: authRedirectUrl() },
  });
  submit.disabled = false;
  if (error) {
    console.error(error);
    setAuthMessage("Не получилось отправить ссылку. Проверь email и настройки redirect URL.", "error");
    return;
  }
  setAuthMessage("Ссылка отправлена. Открой её в этом браузере — после этого план будет синхронизироваться.", "success");
}

async function signOut() {
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) {
    console.error(error);
    showToast("Не получилось выйти из аккаунта");
    return;
  }
  supabaseUser = null;
  lastSessionUserId = null;
  updateAuthControls();
  setStorageStatus("Сохранено в браузере");
  renderAll();
  showToast("Выход выполнен");
}

function hasLocalWeekData(weekKey) {
  const entries = Object.values(getWeekPlan(weekKey).entries || {}).filter(Boolean);
  const shopping = Object.values(getWeekShopping(weekKey)).some((item) => item?.checked || item?.pantry);
  return entries.length > 0 || shopping;
}

function cloudEntryRows(weekKey) {
  const entries = getWeekPlan(weekKey).entries || {};
  return Object.entries(entries)
    .filter(([, recipeId]) => recipeId && recipeById(recipeId))
    .map(([key, recipeId]) => {
      const [day, slot, person] = key.split("|");
      return {
        user_id: supabaseUser.id,
        week_start: weekKey,
        day,
        slot,
        person,
        recipe_id: recipeId,
      };
    });
}

function cloudShoppingRows(weekKey) {
  return Object.entries(getWeekShopping(weekKey))
    .filter(([, status]) => status?.checked || status?.pantry)
    .map(([ingredientKey, status]) => ({
      user_id: supabaseUser.id,
      week_start: weekKey,
      ingredient_key: ingredientKey,
      checked: Boolean(status.checked),
      pantry: Boolean(status.pantry),
    }));
}


function customRecipeFromRow(row) {
  return {
    id: row.recipe_id,
    title: row.title,
    kind: row.kind,
    mealTypes: Array.isArray(row.meal_types) ? row.meal_types : [],
    nutrition: row.nutrition && typeof row.nutrition === "object" ? row.nutrition : { label: "профиль порции" },
    audience: Array.isArray(row.audience) && row.audience.length ? row.audience : ["me", "alina"],
    ingredients: Array.isArray(row.ingredients) ? row.ingredients : [],
    steps: Array.isArray(row.steps) ? row.steps : [],
    tags: Array.isArray(row.tags) ? row.tags : [],
    note: row.note || "",
    description: row.description || "Яркое блюдо для домашнего меню.",
    prepMinutes: Number(row.prep_minutes) || 30,
    image: row.image || "",
    isCustom: true,
  };
}

function customRecipeRow(recipe) {
  return {
    user_id: supabaseUser.id,
    recipe_id: recipe.id,
    title: recipe.title,
    kind: recipe.kind,
    meal_types: recipe.mealTypes,
    audience: recipe.audience,
    nutrition: recipe.nutrition || { label: "профиль порции" },
    ingredients: recipe.ingredients || [],
    steps: recipe.steps || [],
    tags: recipe.tags || [],
    note: recipe.note || "",
    description: recipe.description || "",
    prep_minutes: Number(recipe.prepMinutes) || 30,
    image: recipe.image || "",
  };
}

async function pushCustomRecipes(list = state.customRecipes || []) {
  if (!supabaseUser || !supabase || !list.length) return;
  try {
    const result = await supabase.from("custom_recipes").upsert(
      list.map(customRecipeRow),
      { onConflict: "user_id,recipe_id" },
    );
    if (result.error) throw result.error;
  } catch (error) {
    console.warn("Пользовательские рецепты пока не синхронизированы.", error);
  }
}

async function pullCustomRecipes() {
  if (!supabaseUser || !supabase) return;
  try {
    const result = await supabase
      .from("custom_recipes")
      .select("recipe_id,title,kind,meal_types,audience,nutrition,ingredients,steps,tags,note,description,prep_minutes,image")
      .eq("user_id", supabaseUser.id)
      .order("created_at", { ascending: true });
    if (result.error) throw result.error;

    const cloudRecipes = (result.data || []).map(customRecipeFromRow);
    const localRecipes = state.customRecipes || [];
    const cloudIds = new Set(cloudRecipes.map((recipe) => recipe.id));
    const localOnly = localRecipes.filter((recipe) => !cloudIds.has(recipe.id));

    if (!cloudRecipes.length && localRecipes.length) {
      await pushCustomRecipes(localRecipes);
      return;
    }

    state.customRecipes = [...cloudRecipes, ...localOnly];
    if (localOnly.length) await pushCustomRecipes(localOnly);
    persistLocal();
    renderAll();
  } catch (error) {
    console.warn("Таблица пользовательских рецептов ещё не подключена или недоступна.", error);
  }
}

async function pullCloudWeek(weekKey) {
  if (!supabaseUser || !supabase) return;
  setStorageStatus("Загрузка из Supabase…");
  try {
    const [planResult, entriesResult, shoppingResult] = await Promise.all([
      supabase.from("week_plans").select("mode").eq("user_id", supabaseUser.id).eq("week_start", weekKey).maybeSingle(),
      supabase.from("week_entries").select("day,slot,person,recipe_id").eq("user_id", supabaseUser.id).eq("week_start", weekKey),
      supabase.from("shopping_status").select("ingredient_key,checked,pantry").eq("user_id", supabaseUser.id).eq("week_start", weekKey),
    ]);
    if (planResult.error) throw planResult.error;
    if (entriesResult.error) throw entriesResult.error;
    if (shoppingResult.error) throw shoppingResult.error;

    const cloudHasData = Boolean(planResult.data || entriesResult.data?.length || shoppingResult.data?.length);
    if (!cloudHasData && hasLocalWeekData(weekKey)) {
      await pushCloudWeek(weekKey);
      setStorageStatus("Синхронизировано");
      return;
    }

    const plan = getWeekPlan(weekKey);
    plan.entries = {};
    (entriesResult.data || []).forEach((row) => {
      plan.entries[entryKey(row.day, row.slot, row.person)] = row.recipe_id;
    });
    if (planResult.data?.mode) plan.mode = planResult.data.mode;
    if (weekKey === state.weekStart && plan.mode) state.recipientMode = plan.mode;

    const shopping = {};
    (shoppingResult.data || []).forEach((row) => {
      shopping[row.ingredient_key] = { checked: row.checked, pantry: row.pantry };
    });
    state.shoppingByWeek[weekKey] = shopping;
    if (weekKey === state.weekStart) state.shopping = shopping;
    persistLocal();
    renderAll();
    setStorageStatus("Синхронизировано");
  } catch (error) {
    console.error(error);
    setStorageStatus("Локальный режим");
    showToast("Не удалось загрузить данные Supabase");
  }
}

async function pushCloudWeek(weekKey = state.weekStart) {
  if (!supabaseUser || !supabase) return;
  if (syncInFlight) {
    syncQueued = true;
    return;
  }
  syncInFlight = true;
  try {
    const plan = getWeekPlan(weekKey);
    const mode = plan.mode || (weekKey === state.weekStart ? state.recipientMode : "both");
    plan.mode = mode;
    const planResult = await supabase.from("week_plans").upsert({
      user_id: supabaseUser.id,
      week_start: weekKey,
      mode,
    }, { onConflict: "user_id,week_start" });
    if (planResult.error) throw planResult.error;

    const entriesDelete = await supabase.from("week_entries").delete().eq("user_id", supabaseUser.id).eq("week_start", weekKey);
    if (entriesDelete.error) throw entriesDelete.error;
    const entries = cloudEntryRows(weekKey);
    if (entries.length) {
      const entriesInsert = await supabase.from("week_entries").insert(entries);
      if (entriesInsert.error) throw entriesInsert.error;
    }

    const shoppingDelete = await supabase.from("shopping_status").delete().eq("user_id", supabaseUser.id).eq("week_start", weekKey);
    if (shoppingDelete.error) throw shoppingDelete.error;
    const shopping = cloudShoppingRows(weekKey);
    if (shopping.length) {
      const shoppingInsert = await supabase.from("shopping_status").insert(shopping);
      if (shoppingInsert.error) throw shoppingInsert.error;
    }
    setStorageStatus("Синхронизировано");
  } catch (error) {
    console.error(error);
    setStorageStatus("Локально сохранено");
    showToast("Локально сохранено; синхронизация не удалась");
  } finally {
    syncInFlight = false;
    if (syncQueued) {
      syncQueued = false;
      scheduleCloudSync();
    }
  }
}

function scheduleCloudSync() {
  if (!supabaseUser) return;
  clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => {
    void pushCloudWeek(state.weekStart);
    void pushCustomRecipes();
  }, 500);
}

function changeWeek(value) {
  const nextWeek = mondayISO(value);
  if (nextWeek === state.weekStart) return;
  state.weekStart = nextWeek;
  const plan = getWeekPlan(nextWeek);
  state.recipientMode = plan.mode || state.recipientMode;
  activateShoppingWeek(nextWeek);
  persistLocal();
  renderAll();
  if (supabaseUser) {
    void pullCloudWeek(nextWeek);
  } else {
    setStorageStatus("Сохранено в браузере");
  }
}

async function applySupabaseSession(session) {
  const nextUser = session?.user || null;
  const changed = nextUser?.id !== supabaseUser?.id;
  supabaseUser = nextUser;
  updateAuthControls();
  if (!supabaseUser) {
    lastSessionUserId = null;
    setStorageStatus("Сохранено в браузере");
    renderAll();
    maybeOpenAuthPrompt();
    return;
  }
  if (!changed && lastSessionUserId === supabaseUser.id) return;
  lastSessionUserId = supabaseUser.id;
  await pullCustomRecipes();
  await pullCloudWeek(state.weekStart);
}

async function initSupabase() {
  updateAuthControls();
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    setStorageStatus("Сохранено в браузере");
    return;
  }
  try {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    await applySupabaseSession(data.session);
    supabase.auth.onAuthStateChange((_event, session) => {
      window.setTimeout(() => void applySupabaseSession(session), 0);
    });
  } catch (error) {
    console.error(error);
    setStorageStatus("Локальный режим");
    setAuthMessage("Не удалось подключить Supabase. Приложение продолжает работать локально.", "error");
  }
}

function defaultState() {
  return {
    activeTab: "recipes",
    recipeSearch: "",
    recipeFilter: "all",
    recipeTag: "all",
    weekStart: mondayISO(new Date()),
    recipientMode: "both",
    weeks: {},
    shopping: {},
    shoppingByWeek: {},
    customRecipes: [],
  };
}

function loadState() {
  let next = defaultState();
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    next = { ...next, ...(parsed || {}) };
  } catch {
    next = defaultState();
  }
  if (next.recipientMode === "me" || next.recipientMode === "alina") next.recipientMode = "separate";
  if (next.recipeTag === "только для меня") next.recipeTag = "Мася";
  if (next.activeTab === "shopping") next.activeTab = "ingredients";
  next.weeks ||= {};
  next.customRecipes = Array.isArray(next.customRecipes) ? next.customRecipes.filter((recipe) => recipe && recipe.id && recipe.title) : [];
  next.shoppingByWeek ||= {};
  if (next.shopping && Object.keys(next.shopping).length && !next.shoppingByWeek[next.weekStart]) {
    next.shoppingByWeek[next.weekStart] = next.shopping;
  }
  next.shopping = next.shoppingByWeek[next.weekStart] || {};
  return next;
}

function saveState({ notify = false, sync = true } = {}) {
  persistLocal();
  setStorageStatus(supabaseUser ? "Изменения синхронизируются…" : "Сохранено в браузере");
  renderAll();
  if (sync && supabaseUser) scheduleCloudSync();
  if (notify) showToast(supabaseUser ? "Изменения сохранены и синхронизируются" : "Изменения сохранены");
}

function isoDate(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function dateFromISO(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function addDays(value, days) {
  const date = typeof value === "string" ? dateFromISO(value) : new Date(value);
  date.setDate(date.getDate() + days);
  return date;
}

function mondayISO(value) {
  const date = typeof value === "string" ? dateFromISO(value) : new Date(value);
  const day = date.getDay();
  const delta = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + delta);
  return isoDate(date);
}

function formatDay(date) {
  return new Intl.DateTimeFormat("ru-RU", { weekday: "short" }).format(date).replace(".", "");
}

function formatDayLong(date) {
  return new Intl.DateTimeFormat("ru-RU", { weekday: "long" }).format(date);
}

function formatDateShort(date) {
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" }).format(date).replace(".", "");
}

function normalizeName(value) {
  return value.toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/gi, " ").trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatNumber(value) {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(1).replace(".", ",");
}

function getWeekPlan(weekKey = state.weekStart) {
  if (!state.weeks[weekKey]) state.weeks[weekKey] = { entries: {}, mode: state.recipientMode || "both" };
  if (!state.weeks[weekKey].entries) state.weeks[weekKey].entries = {};
  if (!state.weeks[weekKey].mode) state.weeks[weekKey].mode = state.recipientMode || "both";
  return state.weeks[weekKey];
}

function getWeekShopping(weekKey = state.weekStart) {
  state.shoppingByWeek ||= {};
  state.shoppingByWeek[weekKey] ||= {};
  return state.shoppingByWeek[weekKey];
}

function activateShoppingWeek(weekKey = state.weekStart) {
  state.shopping = getWeekShopping(weekKey);
}

function persistLocal() {
  state.shoppingByWeek ||= {};
  state.shoppingByWeek[state.weekStart] = state.shopping || {};
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function entryKey(day, slot, person) {
  return [day, slot, person].join("|");
}

function getPeopleForMode() {
  return state.recipientMode === "both" ? ["both"] : ["me", "alina"];
}

function getAvailableRecipes(slot, person) {
  return recipeCatalog()
    .filter((recipe) => recipe.mealTypes.includes(slot))
    .filter((recipe) => person === "both" ? recipe.audience.includes("me") && recipe.audience.includes("alina") : recipe.audience.includes(person))
    .sort((a, b) => a.title.localeCompare(b.title, "ru"));
}

function renderAll() {
  renderTabs();
  renderRecipes();
  renderWeek();
  renderIngredients();
}

function renderTabs() {
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.tab === state.activeTab);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    const isVisible = panel.dataset.panel === state.activeTab;
    panel.hidden = !isVisible;
    panel.classList.toggle("is-visible", isVisible);
  });
}

function recipeAudienceTags(recipe) {
  const tags = [];
  if (recipe.audience.includes("me")) tags.push("Мася");
  if (recipe.audience.includes("alina")) tags.push("Кися");
  return tags;
}

function cookingBand(recipe) {
  const minutes = Number(recipe.prepMinutes) || 30;
  if (minutes <= 20) return "quick";
  if (minutes <= 40) return "steady";
  return "slow";
}

function recipeFilterTags(recipe) {
  return [...new Set([...recipe.tags.filter((tag) => !tag.includes("для меня")), ...recipeAudienceTags(recipe), cookingBand(recipe)])];
}

function recipeDisplayTags(recipe) {
  const timeLabel = TIME_FILTERS.find((item) => item.value === cookingBand(recipe))?.label;
  return [...new Set([...recipe.tags.filter((tag) => !tag.includes("для меня")), ...recipeAudienceTags(recipe), timeLabel])].filter(Boolean);
}

function timeLabel(recipe) {
  return `~${Number(recipe.prepMinutes) || 30} мин`;
}

function kindClass(kind) {
  return KIND_CLASSES[kind] || "default";
}
function renderRecipeFilters() {
  const filter = $("recipeFilter");
  filter.innerHTML = RECIPE_FILTERS.map((item) => `<option value="${item.value}">${item.label}</option>`).join("");
  filter.value = state.recipeFilter;

  const baseTags = [...new Set(recipeCatalog().flatMap((recipe) => recipe.tags.filter((tag) => !tag.includes("для меня"))))];
  const tags = [
    { value: "all", label: "Все теги" },
    { value: "Мася", label: "Мася" },
    { value: "Кися", label: "Кися" },
    ...TIME_FILTERS,
    ...baseTags.map((tag) => ({ value: tag, label: tag })),
  ];
  $("recipeTags").innerHTML = tags.map((item) => `<button class="chip chip-button ${state.recipeTag === item.value ? "is-active" : ""}" data-recipe-tag="${escapeHtml(item.value)}" type="button">${escapeHtml(item.label)}</button>`).join("");
}

function nutritionLabel(recipe) {
  return recipe.nutrition?.label || "профиль порции";
}

function renderRecipes() {
  renderRecipeFilters();
  $("recipeSearch").value = state.recipeSearch;
  const query = state.recipeSearch.trim().toLowerCase();
  const filtered = recipeCatalog().filter((recipe) => {
    const matchesQuery = !query || `${recipe.title} ${recipe.kind} ${recipe.tags.join(" ")} ${recipe.description || ""}`.toLowerCase().includes(query);
    const matchesFilter = state.recipeFilter === "all" || recipe.mealTypes.includes(state.recipeFilter) || (state.recipeFilter === "soup" && recipe.kind === "Суп") || (state.recipeFilter === "salad" && recipe.kind === "Салат");
    const matchesTag = state.recipeTag === "all" || recipeFilterTags(recipe).includes(state.recipeTag);
    return matchesQuery && matchesFilter && matchesTag;
  });
  $("recipeCount").textContent = String(recipeCatalog().length);

  $("recipeGrid").innerHTML = filtered.length ? filtered.map((recipe) => `
    <article class="recipe-card" data-recipe-id="${recipe.id}" tabindex="0" role="button" aria-label="Открыть рецепт: ${escapeHtml(recipe.title)}">
      <div class="recipe-card-image"><img src="${escapeHtml(recipe.image || "")}" alt="${escapeHtml(recipe.title)}" loading="eager" decoding="async" /></div>
      <div class="recipe-card-top"><span class="recipe-kind kind-${kindClass(recipe.kind)}">${escapeHtml(recipe.kind)}</span><div class="recipe-card-top-meta"><span class="chip">${recipe.mealTypes.map((slot) => SLOT_LABELS[slot]).join(" · ")}</span><span class="chip time-chip">${timeLabel(recipe)}</span></div></div>
      <h3>${escapeHtml(recipe.title)}</h3>
      <p>${escapeHtml(recipe.description || "Яркое блюдо для удобного домашнего меню.")}</p>
      <div class="recipe-audience">${recipeAudienceTags(recipe).map((person) => `<span class="audience-pill">${escapeHtml(person)}</span>`).join("")}</div>
      <div class="recipe-card-footer"><span class="recipe-macro">${escapeHtml(nutritionLabel(recipe))}</span><span class="button button-secondary">Подробнее</span></div>
    </article>
  `).join("") : `<div class="empty-state"><div><strong>Ничего не найдено</strong><p>Попробуй изменить поиск или фильтр.</p></div></div>`;
}

let selectedRecipeImageData = "";

function recipeIngredientRowHtml(values = {}) {
  const value = (key) => escapeHtml(values[key] ?? "");
  const selectedStorage = values.storage || "fresh";
  const storageOptions = RECIPE_STORAGE_OPTIONS.map((option) => `<option value="${option.value}" ${selectedStorage === option.value ? "selected" : ""}>${option.label}</option>`).join("");
  return `<div class="recipe-ingredient-row" data-ingredient-row>
    <label class="field"><span class="field-label">Ингредиент</span><input data-ingredient-name type="text" value="${value("name")}" placeholder="Например, куриное филе" /></label>
    <label class="field"><span class="field-label">Количество</span><input data-ingredient-amount type="number" min="0.1" step="0.1" value="${value("amount")}" placeholder="150" /></label>
    <label class="field"><span class="field-label">Ед.</span><input data-ingredient-unit type="text" value="${value("unit")}" placeholder="г" /></label>
    <label class="field"><span class="field-label">Категория</span><input data-ingredient-category type="text" value="${value("category")}" placeholder="Овощи" /></label>
    <label class="field"><span class="field-label">Срок, дн.</span><input data-ingredient-shelf type="number" min="1" step="1" value="${value("shelfDays")}" placeholder="7" /></label>
    <label class="field"><span class="field-label">Хранение</span><select data-ingredient-storage>${storageOptions}</select></label>
    <button class="remove-ingredient-button" data-remove-ingredient type="button">Удалить</button>
  </div>`;
}

function addRecipeIngredientRow(values = {}) {
  $("recipeIngredientRows").insertAdjacentHTML("beforeend", recipeIngredientRowHtml(values));
}

function setRecipeFormMessage(message, tone = "") {
  const element = $("recipeFormMessage");
  if (!element) return;
  element.textContent = message;
  element.className = `recipe-form-message${tone ? ` is-${tone}` : ""}`;
}

function updateRecipeImagePreview(source = "") {
  const preview = $("recipeImagePreview");
  if (!preview) return;
  preview.src = source || "";
  preview.hidden = !source;
}

function resetRecipeForm() {
  $("recipeForm").reset();
  $("recipeIngredientRows").innerHTML = "";
  addRecipeIngredientRow();
  selectedRecipeImageData = "";
  updateRecipeImagePreview("");
  setRecipeFormMessage("");
}

function openRecipeEditor() {
  resetRecipeForm();
  $("recipeEditorModal").hidden = false;
  document.body.style.overflow = "hidden";
  $("recipeTitle").focus();
}

function closeRecipeEditor() {
  $("recipeEditorModal").hidden = true;
  document.body.style.overflow = "";
}

function handleRecipeImageFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    setRecipeFormMessage("Выбери файл изображения.", "error");
    event.target.value = "";
    return;
  }
  if (file.size > 1500000) {
    setRecipeFormMessage("Изображение слишком большое. Выбери файл до 1,5 МБ или укажи ссылку.", "error");
    event.target.value = "";
    return;
  }
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    selectedRecipeImageData = String(reader.result || "");
    updateRecipeImagePreview(selectedRecipeImageData);
    setRecipeFormMessage("");
  });
  reader.readAsDataURL(file);
}

function handleRecipeImageUrl(event) {
  if (selectedRecipeImageData) return;
  updateRecipeImagePreview(event.target.value.trim());
}

function recipeId() {
  const token = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `custom-${token}`;
}

function handleRecipeSubmit(event) {
  event.preventDefault();
  const title = $("recipeTitle").value.trim();
  const kind = $("recipeKind").value;
  const mealTypes = [...document.querySelectorAll('input[name="recipeMealType"]:checked')].map((input) => input.value);
  const audience = [...document.querySelectorAll('input[name="recipeAudience"]:checked')].map((input) => input.value);
  const prepMinutes = Number($("recipePrepMinutes").value);
  const rawIngredients = [...document.querySelectorAll("[data-ingredient-row]")].map((row) => ({
    name: row.querySelector("[data-ingredient-name]").value.trim(),
    amount: Number(row.querySelector("[data-ingredient-amount]").value),
    unit: row.querySelector("[data-ingredient-unit]").value.trim(),
    category: row.querySelector("[data-ingredient-category]").value.trim() || "Прочее",
    shelfDays: Number(row.querySelector("[data-ingredient-shelf]").value) || 7,
    storage: row.querySelector("[data-ingredient-storage]").value || "fresh",
  }));
  const ingredients = rawIngredients.filter((ingredient) => ingredient.name);
  const hasInvalidIngredient = ingredients.some((ingredient) => !Number.isFinite(ingredient.amount) || ingredient.amount <= 0 || !ingredient.unit);
  const steps = $("recipeSteps").value.split("\n").map((step) => step.trim()).filter(Boolean);
  if (!title || !kind || !mealTypes.length || !audience.length || !Number.isFinite(prepMinutes) || prepMinutes < 1) {
    setRecipeFormMessage("Заполни название, тип, слот питания, получателя и время готовки.", "error");
    return;
  }
  if (!ingredients.length || hasInvalidIngredient) {
    setRecipeFormMessage("Добавь хотя бы один ингредиент: название, количество и единицу измерения.", "error");
    return;
  }
  if (!steps.length) {
    setRecipeFormMessage("Добавь шаги приготовления — по одному на строку.", "error");
    return;
  }
  const recipe = {
    id: recipeId(),
    title,
    kind,
    mealTypes,
    nutrition: { label: "профиль порции" },
    audience,
    ingredients: ingredients.map((ingredient) => ({ ...ingredient, shelfDays: Math.max(1, Math.round(ingredient.shelfDays)) })),
    steps,
    tags: $("recipeTagsInput").value.split(",").map((tag) => tag.trim()).filter(Boolean),
    note: $("recipeNote").value.trim(),
    description: $("recipeDescription").value.trim() || "Яркое блюдо для домашнего меню.",
    prepMinutes: Math.round(prepMinutes),
    image: selectedRecipeImageData || $("recipeImageUrl").value.trim(),
    isCustom: true,
  };
  state.customRecipes ||= [];
  state.customRecipes.unshift(recipe);
  state.activeTab = "recipes";
  closeRecipeEditor();
  saveState({ notify: true });
}

function renderWeek() {
  $("weekDate").value = state.weekStart;
  $("recipientMode").value = state.recipientMode;
  const plan = getWeekPlan();
  const days = Array.from({ length: 7 }, (_, index) => addDays(state.weekStart, index));
  const people = getPeopleForMode();
  const today = isoDate(new Date());

  const filled = Object.values(plan.entries).filter(Boolean).length;
  const usedRecipes = new Set(Object.values(plan.entries).filter(Boolean)).size;
  const usedDays = new Set(Object.keys(plan.entries).filter((key) => plan.entries[key]).map((key) => key.split("|")[0])).size;
  $("weekSummary").innerHTML = [
    [filled, "заполненных слотов"], [usedDays, "дней с планом"], [usedRecipes, "разных блюд"],
  ].map(([value, label]) => `<div class="summary-card"><strong>${value}</strong><span>${label}</span></div>`).join("");

  const cards = state.recipientMode === "both" ? days.map((date) => renderDayCard(date, "both", today, plan)) : people.flatMap((person) => days.map((date) => renderDayCard(date, person, today, plan)));
  $("weekBoard").innerHTML = cards.join("");
}

function renderDayCard(date, person, today, plan) {
  const day = isoDate(date);
  const separate = person !== "both";
  const badges = `${separate ? `<span class="person-card-label">${PERSON_LABELS[person]}</span>` : ""}${day === today ? '<span class="today-label">Сегодня</span>' : ""}`;
  return `<article class="day-card ${day === today ? "is-today" : ""} ${separate ? `is-separate person-${person}` : ""}">
    <header class="day-card-header"><div><strong>${escapeHtml(formatDayLong(date))}</strong><span>${escapeHtml(formatDateShort(date))}</span></div><div class="day-card-badges">${badges}</div></header>
    <div class="recipient-row ${separate ? "single-recipient" : ""}">
      <div class="recipient-label"><span>${PERSON_LABELS[person]}</span></div>
      ${SLOT_ORDER.map((slot) => renderMealSelect(day, slot, person, plan.entries[entryKey(day, slot, person)])).join("")}
    </div>
  </article>`;
}

function renderMealSelect(day, slot, person, selectedId) {
  const options = getAvailableRecipes(slot, person);
  return `<label class="field"><span class="field-label">${SLOT_LABELS[slot]}</span><select class="meal-select" data-week-choice="true" data-day="${day}" data-slot="${slot}" data-person="${person}">
    <option value="">— выбрать блюдо —</option>
    ${options.map((recipe) => `<option value="${recipe.id}" ${recipe.id === selectedId ? "selected" : ""}>${escapeHtml(recipe.title)}</option>`).join("")}
  </select></label>`;
}

function aggregateIngredients() {
  const plan = getWeekPlan();
  const aggregated = new Map();
  Object.entries(plan.entries).forEach(([key, recipeId]) => {
    if (!recipeId || !recipeById(recipeId)) return;
    const person = key.split("|")[2];
    const factor = person === "both" ? 2 : 1;
    recipeById(recipeId).ingredients.forEach((ingredient) => {
      const aggregateKey = `${normalizeName(ingredient.name)}|${ingredient.unit}`;
      const current = aggregated.get(aggregateKey) || {
        key: aggregateKey,
        name: ingredient.name,
        unit: ingredient.unit,
        category: ingredient.category,
        shelfDays: ingredient.shelfDays,
        storage: ingredient.storage,
        amount: 0,
        recipes: new Set(),
      };
      current.amount += ingredient.amount * factor;
      current.shelfDays = Math.min(current.shelfDays, ingredient.shelfDays);
      current.recipes.add(recipeById(recipeId).title);
      aggregated.set(aggregateKey, current);
    });
  });
  return [...aggregated.values()].map((item) => ({ ...item, recipes: [...item.recipes] }));
}

function categorySort(a, b) {
  const ai = CATEGORY_ORDER.indexOf(a);
  const bi = CATEGORY_ORDER.indexOf(b);
  return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi) || a.localeCompare(b, "ru");
}

function storageHint(item) {
  if (item.storage === "frozen" || item.shelfDays >= 90) return "Можно купить заранее";
  if (item.shelfDays <= 3) return "Купить ближе к готовке";
  if (item.shelfDays <= 7) return "Купить в начале недели";
  return "Можно купить за несколько дней";
}

function renderIngredients() {
  const items = aggregateIngredients();
  const categories = Object.groupBy ? Object.groupBy(items, (item) => item.category) : items.reduce((result, item) => {
    (result[item.category] ||= []).push(item);
    return result;
  }, {});
  const categoryNames = Object.keys(categories).sort(categorySort);
  const fresh = items.filter((item) => item.shelfDays <= 3).length;
  const completed = items.filter((item) => state.shopping[item.key]?.checked || state.shopping[item.key]?.pantry).length;
  const total = items.length;
  const percent = total ? Math.round((completed / total) * 100) : 0;
  $("ingredientStats").innerHTML = `<div class="stat-card"><strong>${total}</strong><span>позиций</span></div><div class="stat-card"><strong>${completed}</strong><span>отмечено</span></div><div class="stat-card"><strong>${fresh}</strong><span>свежих позже</span></div>`;
  $("shoppingProgress").innerHTML = `<div class="progress-track"><div class="progress-fill" style="width:${percent}%"></div></div><span>${completed} из ${total} отмечено</span>`;
  $("ingredientList").innerHTML = categoryNames.length ? categoryNames.map((category) => `<section class="category-card"><header class="category-heading"><h3>${escapeHtml(category)}</h3><span>${categories[category].length} поз.</span></header>${categories[category].sort((a, b) => a.name.localeCompare(b.name, "ru")).map((item) => {
    const status = state.shopping[item.key] || {};
    return `<div class="ingredient-row ${status.checked || status.pantry ? "is-checked" : ""}">
      <div class="ingredient-main"><strong>${escapeHtml(item.name)}</strong><small>Для: ${escapeHtml(item.recipes.slice(0, 2).join(", "))}${item.recipes.length > 2 ? "…" : ""}</small></div>
      <div class="ingredient-amount">${formatNumber(item.amount)} ${escapeHtml(item.unit)}</div>
      <div class="storage-hint">${storageHint(item)}<br><span>срок около ${item.shelfDays} дн.</span></div>
      <div class="ingredient-actions">
        <button class="check-button ${status.checked ? "is-checked" : ""}" data-shopping-action="checked" data-ingredient-key="${escapeHtml(item.key)}" type="button" aria-label="${status.checked ? "Снять отметку" : "Отметить купленным"}">${status.checked ? "✓" : ""}</button>
        <button class="pantry-toggle ${status.pantry ? "is-home" : ""}" data-shopping-action="pantry" data-ingredient-key="${escapeHtml(item.key)}" type="button">${status.pantry ? "Есть дома" : "Уже есть?"}</button>
      </div>
    </div>`;
  }).join("")}</section>`).join("") : `<div class="empty-state"><div><strong>Пока нет ингредиентов</strong><p>Заполни хотя бы один слот в недельном рационе.</p></div></div>`;
}

function openRecipe(recipeId) {
  const recipe = recipeById(recipeId);
  if (!recipe) return;
  $("modalContent").innerHTML = `<p class="eyebrow">${escapeHtml(recipe.kind)}</p><h2 id="modalTitle">${escapeHtml(recipe.title)}</h2><p class="modal-subtitle">${escapeHtml(recipe.note || "Рецепт из общего каталога. Количества указаны на одну порцию для расчёта списка продуктов.")}</p><div class="modal-meta"><span class="chip is-active">${escapeHtml(nutritionLabel(recipe))}</span>${recipeDisplayTags(recipe).map((tag) => `<span class="chip">${escapeHtml(tag)}</span>`).join("")}</div><section class="modal-section"><h3>Ингредиенты</h3><ul class="modal-ingredients">${recipe.ingredients.map((ingredient) => `<li><strong>${escapeHtml(ingredient.name)}</strong><span>${formatNumber(ingredient.amount)} ${escapeHtml(ingredient.unit)}</span></li>`).join("")}</ul></section><section class="modal-section"><h3>Приготовление</h3><ol>${recipe.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol></section><div class="note-box">Ориентир по хранению: скоропортящиеся продукты лучше покупать ближе к готовке, заморозку и бакалею — заранее. Значения пищевой информации здесь справочные и не используются для персональных целей или ограничений.</div>`;
  $("recipeModal").hidden = false;
  document.body.style.overflow = "hidden";
}

function closeModal() {
  $("recipeModal").hidden = true;
  document.body.style.overflow = "";
}

function setTab(tab) {
  state.activeTab = tab;
  saveState({ sync: false });
}

function showToast(message) {
  const element = $("toast");
  element.textContent = message;
  element.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("is-visible"), 2400);
}

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `meal-planner-${state.weekStart}.json`;
  link.click();
  URL.revokeObjectURL(url);
  showToast("Файл экспорта подготовлен");
}

function copyPreviousWeek() {
  const previousKey = isoDate(addDays(state.weekStart, -7));
  if (!state.weeks[previousKey]) {
    showToast("Предыдущая неделя ещё не заполнена");
    return;
  }
  state.weeks[state.weekStart] = JSON.parse(JSON.stringify(state.weeks[previousKey]));
  activateShoppingWeek(state.weekStart);
  saveState({ notify: true });
}

function toggleShopping(action, key) {
  state.shopping[key] ||= {};
  state.shopping[key][action] = !state.shopping[key][action];
  saveState();
}

function bindEvents() {
  document.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-tab]");
    if (tab) setTab(tab.dataset.tab);

    const recipeCard = event.target.closest("[data-recipe-id]");
    if (recipeCard) openRecipe(recipeCard.dataset.recipeId);

    const tag = event.target.closest("[data-recipe-tag]");
    if (tag) {
      state.recipeTag = tag.dataset.recipeTag;
      saveState();
    }

    const shoppingButton = event.target.closest("[data-shopping-action]");
    if (shoppingButton) toggleShopping(shoppingButton.dataset.shoppingAction, shoppingButton.dataset.ingredientKey);
  });

  $("recipeSearch").addEventListener("input", (event) => { state.recipeSearch = event.target.value; renderRecipes(); });
  $("recipeFilter").addEventListener("change", (event) => { state.recipeFilter = event.target.value; saveState({ sync: false }); });
  $("weekDate").addEventListener("change", (event) => { changeWeek(event.target.value); });
  $("recipientMode").addEventListener("change", (event) => {
    state.recipientMode = event.target.value;
    getWeekPlan().mode = state.recipientMode;
    saveState();
  });
  $("previousWeek").addEventListener("click", () => { changeWeek(addDays(state.weekStart, -7)); });
  $("nextWeek").addEventListener("click", () => { changeWeek(addDays(state.weekStart, 7)); });
  $("copyPreviousWeek").addEventListener("click", copyPreviousWeek);
  $("exportData").addEventListener("click", exportData);
  $("clearShoppingChecks").addEventListener("click", () => { state.shoppingByWeek[state.weekStart] = {}; state.shopping = state.shoppingByWeek[state.weekStart]; saveState({ notify: true }); });
  $("addRecipeButton").addEventListener("click", openRecipeEditor);
  $("recipeForm").addEventListener("submit", handleRecipeSubmit);
  $("addIngredientRow").addEventListener("click", () => addRecipeIngredientRow());
  $("recipeIngredientRows").addEventListener("click", (event) => {
    const removeButton = event.target.closest("[data-remove-ingredient]");
    if (!removeButton) return;
    const rows = $("recipeIngredientRows").querySelectorAll("[data-ingredient-row]");
    if (rows.length <= 1) {
      setRecipeFormMessage("Оставь хотя бы одну строку ингредиентов.", "error");
      return;
    }
    removeButton.closest("[data-ingredient-row]").remove();
  });
  $("recipeImageFile").addEventListener("change", handleRecipeImageFile);
  $("recipeImageUrl").addEventListener("input", handleRecipeImageUrl);
  $("closeRecipeEditor").addEventListener("click", closeRecipeEditor);
  $("cancelRecipeEditor").addEventListener("click", closeRecipeEditor);
  $("recipeEditorModal").addEventListener("click", (event) => { if (event.target === $("recipeEditorModal")) closeRecipeEditor(); });
  $("authButton").addEventListener("click", openAuthModal);
  $("authForm").addEventListener("submit", sendMagicLink);
  $("closeAuthModal").addEventListener("click", closeAuthModal);
  $("authModal").addEventListener("click", (event) => { if (event.target === $("authModal")) closeAuthModal(); });
  $("closeModal").addEventListener("click", closeModal);
  $("recipeModal").addEventListener("click", (event) => { if (event.target === $("recipeModal")) closeModal(); });
  $("weekBoard").addEventListener("change", (event) => {
    const select = event.target.closest("[data-week-choice]");
    if (!select) return;
    const plan = getWeekPlan();
    const key = entryKey(select.dataset.day, select.dataset.slot, select.dataset.person);
    if (select.value) plan.entries[key] = select.value;
    else delete plan.entries[key];
    saveState({ notify: true });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!$("recipeModal").hidden) closeModal();
    if (!$("recipeEditorModal").hidden) closeRecipeEditor();
    if (!$("authModal").hidden) closeAuthModal();
  });
}

renderAll();
bindEvents();
void initSupabase();
