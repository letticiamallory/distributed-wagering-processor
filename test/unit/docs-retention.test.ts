import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

// N-5 da segunda avaliação: inbox_messages, outbox_messages (já publicadas) e
// consumer_delivery_failures só crescem, e nada dizia o que fazer com elas. As limitações do
// ARCHITECTURE.md têm que dizer, para cada uma, por quanto tempo a linha serve e como se limparia.
const limitations = (() => {
  const text = readFileSync('ARCHITECTURE.md', 'utf8');
  const start = text.indexOf('## 7. Riscos, limitações e trabalho futuro');
  const end = text.indexOf('\n## 8.', start);
  return text.slice(start, end);
})();

describe('ARCHITECTURE section 7 covers the retention of the tables that only grow', () => {
  test.each([
    'inbox_messages',
    'outbox_messages',
    'consumer_delivery_failures',
  ])('%s', (table) => {
    expect(limitations).toContain(`\`${table}\``);
  });

  test('says how long a row is useful and how it would be cleaned', () => {
    expect(limitations).toMatch(/retenção/i);
    expect(limitations).toContain('MessageRetentionPeriod');
    expect(limitations).toMatch(/DELETE/);
    expect(limitations).toMatch(/em lotes/);
  });
});
