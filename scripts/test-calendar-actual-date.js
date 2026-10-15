const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const start = html.indexOf('    function getStudentScheduleMonthOptions(');
const end = html.indexOf('    function getCourseNameById(', start);

if (start === -1 || end === -1) throw new Error('Calendar source block not found');

function setup() {
  const context = {
    getLocalDateString: () => '2026-10-15',
    getMonthlySessionMonthKey: session => session.monthKey || '',
    getMonthlyPlanGridDays(monthKey) {
      const [year, month] = monthKey.split('-').map(Number);
      const days = [];
      const date = new Date(year, month - 1, 1);
      while (date.getMonth() === month - 1) {
        days.push(new Date(date));
        date.setDate(date.getDate() + 1);
      }
      return days;
    },
    getMonthlySessionDate: session => session.date || '',
    getActiveHolidayForCalendarDate: () => null,
    padNumber: (value, length) => String(value).padStart(length, '0'),
    escapeHtml: value => String(value),
    console
  };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  return context;
}

test('student calendar keeps the actual current month even when it has no class sessions', () => {
  const context = setup();
  const months = context.getStudentScheduleMonthOptions([{ monthKey: '2026-11' }]);
  assert.deepEqual(Array.from(months), ['2026-10', '2026-11']);
});

test('calendar dates without class sessions remain selectable', () => {
  const context = setup();
  const calendar = context.renderTeacherMiniCalendar('2026-10', [], '2026-10-15', 'selectStudentCalendarDay');
  assert.match(calendar, /data-date="2026-10-15" onclick="selectStudentCalendarDay\('2026-10-15'\)"/);
});

test('calendar selects the actual date in the current month without requiring a class session', () => {
  const context = setup();
  assert.equal(context.getCalendarSelectedDate('2026-10', '', []), '2026-10-15');
  assert.equal(context.getCalendarSelectedDate('2026-11', '', ['2026-11-20']), '2026-11-01');
});
