'use strict';

const ukrainian = Object.freeze({
  'File':'Файл','Edit':'Редагування','View':'Вигляд','Go':'Перехід','Board':'Дошка','Reader':'Читання','Help':'Довідка',
  'New note':'Нова нотатка','New project…':'Новий проєкт…','New board…':'Нова дошка…','Import files…':'Імпортувати файли…',
  'Save note':'Зберегти нотатку','Export workspace backup…':'Експортувати резервну копію…','Load backup…':'Завантажити резервну копію…',
  'Settings…':'Налаштування…','Exit noteject':'Вийти з Noteject','Undo':'Скасувати','Redo':'Повторити','Cut':'Вирізати','Copy':'Копіювати','Paste':'Вставити',
  'Select all':'Вибрати все','Search workspace…':'Пошук у робочому просторі…','Command palette…':'Меню команд…','Toggle navigation pane':'Показати або приховати бічну панель',
  'Actual interface size':'Початковий розмір інтерфейсу','Larger interface':'Збільшити інтерфейс','Smaller interface':'Зменшити інтерфейс','Full screen':'На весь екран','Reload workspace':'Перезавантажити робочий простір',
  'Home':'Головна','All notes':'Усі нотатки','Documents':'Документи','Projects':'Проєкти','Boards':'Дошки','Graph view':'Граф зв’язків',
  'Commands':'Команди','Return to Home':'Повернутися на головну','Ask this document':'Запитати про цей документ',
  'Previous file':'Попередній файл','Next file':'Наступний файл','Download original':'Завантажити оригінал',
  'Import':'Імпорт','Files + Import':'Файли + імпорт','No content yet.':'Вмісту поки немає.','READER MENU':'МЕНЮ ЧИТАННЯ',
  'Fit board to window':'Умістити дошку у вікні','Zoom in on board':'Збільшити масштаб дошки','Zoom out on board':'Зменшити масштаб дошки',
  'Find in document…':'Знайти в документі…','Bookmark current place':'Додати закладку на цьому місці','Focus reading':'Зосереджене читання','Increase document size':'Збільшити документ','Decrease document size':'Зменшити документ',
  'Keyboard shortcuts':'Сполучення клавіш','About noteject':'Про Noteject','noteject for Windows':'Noteject для Windows','Version':'Версія',
  'Notes, projects, boards, and reading in your local workspace.':'Нотатки, проєкти, дошки й читання у вашому локальному робочому просторі.',
  'Choose project attachments location':'Виберіть розташування вкладень проєкту','Choose folder':'Вибрати папку',
  'Could not start Noteject':'Не вдалося запустити Noteject','Noteject could not start its local desktop services.':'Noteject не вдалося запустити локальні служби застосунку.'
});

let catalogs = {};
try { catalogs = require('./locale-catalogs.json'); } catch {}
const supportedLanguages = ['en','es','fr','de','it','pt','ru','uk','zh','ja','ko','ar','hi','tr'];
function resolveLanguage(value) {
  const code = String(value || '').toLowerCase().replace('_','-').split('-')[0];
  return supportedLanguages.includes(code) ? code : 'en';
}
function text(source, language) {
  const code = resolveLanguage(language), key = source.replace(/&/g, '');
  if (code === 'en') return source;
  return (code === 'uk' ? ukrainian[key] : null) || catalogs[code]?.[key] || source;
}
function menu(template, language) {
  return template.map(item => ({...item, ...(item.label ? {label:text(item.label, language)} : {}), ...(Array.isArray(item.submenu) ? {submenu:menu(item.submenu, language)} : {})}));
}
module.exports = { text, menu, resolveLanguage, supportedLanguages };
