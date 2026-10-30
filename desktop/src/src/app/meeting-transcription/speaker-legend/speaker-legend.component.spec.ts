import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SpeakerLegendComponent, type NameRequest } from './speaker-legend.component';
import { speakerOfId, type Speaker } from '../speaker-names';

function speaker(id: number, lines: number, name?: string): Speaker {
  return { ...speakerOfId(id, name ? { [String(id)]: name } : {}), lines };
}

describe('SpeakerLegendComponent', () => {
  let fixture: ComponentFixture<SpeakerLegendComponent>;
  let named: NameRequest[];
  let hovered: (number | null)[];
  let reapplied: number;

  const all = (id: string): HTMLElement[] =>
    Array.from(fixture.nativeElement.querySelectorAll(`[data-testid="${id}"]`));
  const q = (id: string): HTMLElement | null =>
    fixture.nativeElement.querySelector(`[data-testid="${id}"]`);

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [SpeakerLegendComponent] }).compileComponents();
    fixture = TestBed.createComponent(SpeakerLegendComponent);
    named = [];
    hovered = [];
    reapplied = 0;
    fixture.componentInstance.name.subscribe((r) => named.push(r));
    fixture.componentInstance.hover.subscribe((id) => hovered.push(id));
    fixture.componentInstance.reapply.subscribe(() => reapplied++);
  });

  function render(speakers: Speaker[], canReapply = false, highlighted: number | null = null) {
    fixture.componentRef.setInput('speakers', speakers);
    fixture.componentRef.setInput('canReapply', canReapply);
    fixture.componentRef.setInput('highlighted', highlighted);
    fixture.detectChanges();
  }

  it('draws one button per speaker, dashed while unnamed, with a pencil only when unnamed', () => {
    render([speaker(1, 14, 'Marta'), speaker(3, 3)]);
    const chips = all('speaker-chip');
    expect(chips.map((c) => c.tagName)).toEqual(['BUTTON', 'BUTTON']);
    expect(chips[0].className).not.toContain('border-dashed');
    expect(chips[1].className).toContain('border-dashed');
    expect(chips[0].querySelector('app-icon')).toBeNull();
    expect(chips[1].querySelector('app-icon')).not.toBeNull();
    expect(chips[0].textContent).toContain('14 lines');
    expect(chips[1].getAttribute('aria-label')).toBe('Name Speaker 3, 3 lines');
  });

  it('asks to name a speaker with the chip as the focus target', () => {
    render([speaker(1, 2)]);
    all('speaker-chip')[0].click();
    expect(named).toEqual([{ id: 1, trigger: all('speaker-chip')[0] }]);
  });

  it('reports the speaker under the pointer or focus, and when it left', () => {
    render([speaker(2, 2)]);
    const chip = all('speaker-chip')[0];
    chip.dispatchEvent(new Event('mouseenter'));
    chip.dispatchEvent(new Event('mouseleave'));
    chip.dispatchEvent(new Event('focus'));
    chip.dispatchEvent(new Event('blur'));
    expect(hovered).toEqual([2, null, 2, null]);
  });

  it('marks the highlighted speaker', () => {
    render([speaker(1, 2), speaker(2, 1, 'Paweł')], false, 2);
    expect(all('speaker-chip')[1].className).toContain('border-[var(--accent)]');
    expect(all('speaker-chip')[0].className).not.toContain('border-[var(--accent)]');
  });

  it('folds speakers past the fourth into +N, dashed when an unnamed one is hidden', () => {
    render([1, 2, 3, 4, 5].map((id) => speaker(id, 6 - id, id === 5 ? undefined : `P${id}`)));
    expect(all('speaker-chip').length).toBe(4);
    expect(q('speaker-more')!.textContent?.replace(/\s+/g, ' ').trim()).toBe('+1 · 1 unnamed');
    expect(q('speaker-more')!.className).toContain('border-dashed');
    q('speaker-more')!.click();
    fixture.detectChanges();
    expect(all('speaker-chip').length).toBe(5);
    expect(q('speaker-more')).toBeNull();
    q('speaker-fewer')!.click();
    fixture.detectChanges();
    expect(all('speaker-chip').length).toBe(4);
  });

  it('wraps onto a second row instead of running past a narrow pane, and caps a chip at its width', () => {
    render([1, 2, 3, 4, 5].map((id) => speaker(id, 200 + id)));
    expect(q('speaker-legend')!.className).toContain('flex-wrap');
    for (const chip of all('speaker-chip')) {
      expect(chip.className).toContain('max-w-[min(16rem,100%)]');
      expect(chip.className).not.toContain('shrink-0');
    }
  });

  it('shows no +N for four speakers or fewer', () => {
    render([1, 2, 3, 4].map((id) => speaker(id, 1)));
    expect(q('speaker-more')).toBeNull();
    expect(q('speaker-fewer')).toBeNull();
  });

  it('only shows the speakers while they cannot be named', () => {
    fixture.componentRef.setInput('editable', false);
    render([speaker(1, 2), speaker(2, 1, 'Paweł')], true);
    const chips = all('speaker-chip') as HTMLButtonElement[];
    expect(chips.every((c) => c.disabled)).toBe(true);
    expect(chips[0].querySelector('app-icon')).toBeNull();
    expect(chips[0].getAttribute('aria-label')).toBe('Speaker 1, 2 lines');
    expect(q('speaker-reapply')).toBeNull();
  });

  it('keeps the accent on a highlighted unnamed chip, not the dashed line colour', () => {
    render([speaker(1, 2)], false, 1);
    expect(all('speaker-chip')[0].className).toContain('border-[var(--accent)]');
    expect(all('speaker-chip')[0].className).not.toContain('border-[var(--line-strong)]');
  });

  it('offers Reapply names only when asked to, and reports a click', () => {
    render([speaker(1, 2)]);
    expect(q('speaker-reapply')).toBeNull();
    render([speaker(1, 2)], true);
    q('speaker-reapply')!.click();
    expect(reapplied).toBe(1);
  });

  it('explains the approximate labels to keyboard and screen-reader users too', () => {
    render([speaker(1, 2)]);
    const note = q('speaker-approximate')!;
    expect(note.tagName).toBe('BUTTON');
    expect(note.getAttribute('aria-label')).toContain('one person can get two labels');
    expect(note.getAttribute('aria-label')).toContain('Claude');
  });
});
