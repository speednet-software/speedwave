import { describe, it, expect } from 'vitest';
import { eventValue, eventChecked } from './dom-event';

describe('dom-event helpers', () => {
  it('eventValue reads the target value of an input', () => {
    const input = document.createElement('input');
    input.value = 'hello';
    const ev = { target: input } as unknown as Event;
    expect(eventValue(ev)).toBe('hello');
  });

  it('eventValue reads the target value of a select', () => {
    const select = document.createElement('select');
    const opt = document.createElement('option');
    opt.value = 'grpc';
    select.append(opt);
    select.value = 'grpc';
    const ev = { target: select } as unknown as Event;
    expect(eventValue(ev)).toBe('grpc');
  });

  it('eventChecked reads the checked state of a checkbox', () => {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    const ev = { target: box } as unknown as Event;
    expect(eventChecked(ev)).toBe(true);
    box.checked = false;
    expect(eventChecked({ target: box } as unknown as Event)).toBe(false);
  });
});
