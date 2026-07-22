import { RECIPE_FILTERS, SLOT_LABELS, recipeMap, recipes } from "./data.js?v=design-20260722";

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
  return next;
}

function saveState({ notify = false } = {}) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  $("storageStatus").textContent = "Сохранено в браузере";
  renderAll();
  if (notify) showToast("Изменения сохранены");
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
  if (!state.weeks[weekKey]) state.weeks[weekKey] = { entries: {} };
  if (!state.weeks[weekKey].entries) state.weeks[weekKey].entries = {};
  return state.weeks[weekKey];
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
      <div class="recipe-card-image"><img src="${escapeHtml(recipe.image || "")}" alt="${escapeHtml(recipe.title)}" loading="lazy" decoding="async" /></div>
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

  $("weekBoard").innerHTML = days.map((date) => {
    const day = isoDate(date);
    return `<article class="day-card ${day === today ? "is-today" : ""}">
      <header class="day-card-header"><div><strong>${escapeHtml(formatDayLong(date))}</strong><span>${escapeHtml(formatDateShort(date))}</span></div>${day === today ? '<span class="today-label">Сегодня</span>' : ""}</header>
      ${people.map((person, index) => `<div class="recipient-row">
        <div class="recipient-label"><span class="${index === 0 && state.recipientMode !== "both" ? "primary-label" : ""}">${PERSON_LABELS[person]}</span>${state.recipientMode !== "both" && index === 0 ? "<span>основной</span>" : ""}</div>
        ${SLOT_ORDER.map((slot) => renderMealSelect(day, slot, person, plan.entries[entryKey(day, slot, person)])).join("")}
      </div>`).join("")}
    </article>`;
  }).join("");
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
  saveState();
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
  $("recipeFilter").addEventListener("change", (event) => { state.recipeFilter = event.target.value; saveState(); });
  $("weekDate").addEventListener("change", (event) => { state.weekStart = mondayISO(event.target.value); saveState(); });
  $("recipientMode").addEventListener("change", (event) => { state.recipientMode = event.target.value; saveState(); });
  $("previousWeek").addEventListener("click", () => { state.weekStart = isoDate(addDays(state.weekStart, -7)); saveState(); });
  $("nextWeek").addEventListener("click", () => { state.weekStart = isoDate(addDays(state.weekStart, 7)); saveState(); });
  $("copyPreviousWeek").addEventListener("click", copyPreviousWeek);
  $("exportData").addEventListener("click", exportData);
  $("clearShoppingChecks").addEventListener("click", () => { state.shopping = {}; saveState({ notify: true }); });
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
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !$("recipeModal").hidden) closeModal(); });
}

renderAll();
bindEvents();
