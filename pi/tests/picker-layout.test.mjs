import test from 'node:test';
import assert from 'node:assert/strict';
import { composePickerLines, pickerSpanAt } from '../lib/ui/picker-layout.mjs';
import { APPROVE_CHOICES, APPROVE_INTRO } from '../lib/ui/option-choices.mjs';

test('picker puts the intro above a two-column choice and keeps the wrapped description', () => {
  const view = composePickerLines({ intro: APPROVE_INTRO, items: APPROVE_CHOICES, selectedIndex: 1, width: 46, maxLines: 24 });
  const text = view.lines.join('\n');
  assert.match(view.lines[0], /подтверждение/);
  assert.match(text, /→ safe/);
  assert.match(text, /запись файлов/);
  assert.equal(text.includes('…'), false);
  assert.equal(view.spans.length, APPROVE_CHOICES.length);
});

test('a click row maps back to the choice index', () => {
  const view = composePickerLines({ intro: '', items: APPROVE_CHOICES, selectedIndex: 0, width: 60 });
  const span = view.spans[2];
  assert.equal(pickerSpanAt(view.spans, span.from)?.index, 2);
  assert.equal(pickerSpanAt(view.spans, -1), null);
});
