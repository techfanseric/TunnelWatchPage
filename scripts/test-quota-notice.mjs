import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the real UI functions without network calls or production data writes.
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('function noteQuotaFailure('), source.indexOf('function startUsageTimer('));
const nodes = { 'quota-notice': { hidden: true }, 'quota-notice-detail': { textContent: '' } };
let now = Date.parse('2026-09-02T03:00:00Z');
class Clock extends Date { static now() { return now; } }
const context = vm.createContext({ document: { getElementById: id => nodes[id] }, Date: Clock });
vm.runInContext(`let latestUsage = null; let quotaFailureAt = 0; ${functions}`, context);
vm.runInContext('renderQuotaNotice()', context);
assert.equal(nodes['quota-notice'].hidden, true);
vm.runInContext(`latestUsage = { rowsRead: 6000000, limit: 5000000, databaseRowsRead: 347, windowEnd: '2026-09-03T00:00:00Z' }; renderQuotaNotice()`, context);
assert.equal(nodes['quota-notice'].hidden, false);
assert.match(nodes['quota-notice-detail'].textContent, /6,000,000/);
assert.match(nodes['quota-notice-detail'].textContent, /347/);
assert.match(nodes['quota-notice-detail'].textContent, /09\/03 08:00/);
vm.runInContext('latestUsage.rowsRead = 100; renderQuotaNotice()', context);
assert.equal(nodes['quota-notice'].hidden, true);
vm.runInContext(`noteQuotaFailure({error: 'D1_DAILY_READ_LIMIT'})`, context);
assert.equal(nodes['quota-notice'].hidden, false, 'confirmed API error takes priority over delayed analytics');
now = Date.parse('2026-09-03T01:00:00Z');
vm.runInContext('renderQuotaNotice()', context);
assert.equal(nodes['quota-notice'].hidden, true, 'previous-day quota must not remain an active alert');
console.log('PASS: quota notice visibility, account/local counts, Beijing reset, API confirmation, rollover');
