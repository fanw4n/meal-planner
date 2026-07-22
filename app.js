import { RECIPE_FILTERS, SLOT_LABELS, recipeMap, recipes } from "./data.js?v=design7-20260722";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./supabase-config.js?v=sync2-20260722";

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
let toastTimer;
let supabase = null;
let supabaseUser = null;
let syncTimer = null;
let syncInFlight = false;
let syncQueued = false;
let lastSessionUserId = null;


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
  $("authModal").hidden = false;
  $("authEmail").focus();
  setAuthMessage(supabase ? "Введи email — отправлю одноразовую ссылку для входа." : "Подключаю синхронизацию…");
}

function closeAuthModal() {
  $("authModal").hidden = true;
  setAuthMessage("");
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
    .filter(([, recipeId]) => recipeId && recipeMap[recipeId])
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
  syncTimer = window.setTimeout(() => void pushCloudWeek(state.weekStart), 500);
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
    return;
  }
  if (!changed && lastSessionUserId === supabaseUser.id) return;
  lastSessionUserId = supabaseUser.id;
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
  next.weeks ||= {};
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
  return recipes
    .filter((recipe) => recipe.mealTypes.includes(slot))
    .filter((recipe) => person === "both" ? recipe.audience.includes("me") && recipe.audience.includes("alina") : recipe.audience.includes(person))
    .sort((a, b) => a.title.localeCompare(b.title, "ru"));
}

function renderAll() {
  renderTabs();
  renderRecipes();
  renderWeek();
  renderIngredients();
  renderShopping();
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

  const baseTags = [...new Set(recipes.flatMap((recipe) => recipe.tags.filter((tag) => !tag.includes("для меня"))))];
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
  const filtered = recipes.filter((recipe) => {
    const matchesQuery = !query || `${recipe.title} ${recipe.kind} ${recipe.tags.join(" ")} ${recipe.description || ""}`.toLowerCase().includes(query);
    const matchesFilter = state.recipeFilter === "all" || recipe.mealTypes.includes(state.recipeFilter) || (state.recipeFilter === "soup" && recipe.kind === "Суп") || (state.recipeFilter === "salad" && recipe.kind === "Салат");
    const matchesTag = state.recipeTag === "all" || recipeFilterTags(recipe).includes(state.recipeTag);
    return matchesQuery && matchesFilter && matchesTag;
  });
  $("recipeCount").textContent = String(recipes.length);

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
    if (!recipeId || !recipeMap[recipeId]) return;
    const person = key.split("|")[2];
    const factor = person === "both" ? 2 : 1;
    recipeMap[recipeId].ingredients.forEach((ingredient) => {
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
      current.recipes.add(recipeMap[recipeId].title);
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
  const total = items.length;
  $("ingredientStats").innerHTML = `<div class="stat-card"><strong>${total}</strong><span>позиций</span></div><div class="stat-card"><strong>${fresh}</strong><span>свежих позже</span></div>`;
  $("ingredientList").innerHTML = categoryNames.length ? categoryNames.map((category) => `<section class="category-card"><header class="category-heading"><h3>${escapeHtml(category)}</h3><span>${categories[category].length} поз.</span></header>${categories[category].sort((a, b) => a.name.localeCompare(b.name, "ru")).map((item) => `<div class="ingredient-row"><div><strong>${escapeHtml(item.name)}</strong><small>Для: ${escapeHtml(item.recipes.slice(0, 2).join(", "))}${item.recipes.length > 2 ? "…" : ""}</small></div><div class="ingredient-amount">${formatNumber(item.amount)} ${escapeHtml(item.unit)}</div><div class="storage-hint">${storageHint(item)}<br><span>срок около ${item.shelfDays} дн.</span></div></div>`).join("")}</section>`).join("") : `<div class="empty-state"><div><strong>Пока нет ингредиентов</strong><p>Заполни хотя бы один слот в недельном рационе.</p></div></div>`;
}

function renderShopping() {
  const items = aggregateIngredients();
  const completed = items.filter((item) => state.shopping[item.key]?.checked || state.shopping[item.key]?.pantry).length;
  const percent = items.length ? Math.round((completed / items.length) * 100) : 0;
  $("shoppingCount").textContent = String(Math.max(items.length - completed, 0));
  $("shoppingProgress").innerHTML = `<div class="progress-track"><div class="progress-fill" style="width:${percent}%"></div></div><span>${completed} из ${items.length} отмечено</span>`;

  const groups = items.reduce((result, item) => {
    (result[item.category] ||= []).push(item);
    return result;
  }, {});
  const categoryNames = Object.keys(groups).sort(categorySort);
  $("shoppingList").innerHTML = categoryNames.length ? categoryNames.map((category) => `<section class="shopping-group"><h3>${escapeHtml(category)}</h3>${groups[category].sort((a, b) => a.name.localeCompare(b.name, "ru")).map((item) => {
    const status = state.shopping[item.key] || {};
    return `<div class="shopping-item ${status.checked || status.pantry ? "is-checked" : ""}">
      <button class="check-button ${status.checked ? "is-checked" : ""}" data-shopping-action="checked" data-ingredient-key="${escapeHtml(item.key)}" type="button" aria-label="${status.checked ? "Снять отметку" : "Отметить купленным"}">${status.checked ? "✓" : ""}</button>
      <div class="shopping-name">${escapeHtml(item.name)}<small>${storageHint(item)}</small></div>
      <div class="shopping-amount">${formatNumber(item.amount)} ${escapeHtml(item.unit)}</div>
      <button class="pantry-toggle ${status.pantry ? "is-home" : ""}" data-shopping-action="pantry" data-ingredient-key="${escapeHtml(item.key)}" type="button">${status.pantry ? "Есть дома" : "Уже есть?"}</button>
    </div>`;
  }).join("")}</section>`).join("") : `<div class="empty-state"><div><strong>Список пока пуст</strong><p>После заполнения недельного рациона здесь появятся покупки.</p></div></div>`;
}

function openRecipe(recipeId) {
  const recipe = recipeMap[recipeId];
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
    if (!$("authModal").hidden) closeAuthModal();
  });
}

renderAll();
bindEvents();
void initSupabase();
