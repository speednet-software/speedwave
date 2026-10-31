import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SpeakerNameDialogComponent } from './speaker-name-dialog.component';

describe('SpeakerNameDialogComponent', () => {
  let fixture: ComponentFixture<SpeakerNameDialogComponent>;
  let events: string[];

  const q = (id: string): HTMLElement | null =>
    fixture.nativeElement.querySelector(`[data-testid="${id}"]`);
  const field = (): HTMLInputElement => q('speaker-name-input') as HTMLInputElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SpeakerNameDialogComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(SpeakerNameDialogComponent);
    fixture.componentRef.setInput('heading', 'Name for Speaker 2');
    fixture.componentRef.setInput('initial', 'Paw');
    fixture.componentRef.setInput('describe', (typed: string) => `typed: ${typed}`);
    events = [];
    fixture.componentInstance.saved.subscribe((v) => events.push(`saved:${v}`));
    fixture.componentInstance.cancelled.subscribe(() => events.push('cancelled'));
    fixture.componentInstance.dismissed.subscribe(() => events.push('dismissed'));
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('opens focused on the field with its text selected, labelled by the heading', () => {
    expect(document.activeElement).toBe(field());
    expect(field().selectionStart).toBe(0);
    expect(field().selectionEnd).toBe(3);
    expect(q('speaker-name-dialog')!.getAttribute('role')).toBe('dialog');
    expect(q('speaker-name-dialog')!.getAttribute('aria-label')).toBe('Name for Speaker 2');
    expect(field().getAttribute('maxlength')).toBe('40');
    expect(field().getAttribute('aria-describedby')).toBe(q('speaker-name-note')!.id);
  });

  it('works out the note from what is typed, on every keystroke', () => {
    expect(q('speaker-name-note')!.textContent?.trim()).toBe('typed: Paw');
    field().value = 'Paweł';
    field().dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(q('speaker-name-note')!.textContent?.trim()).toBe('typed: Paweł');
  });

  it('saves on Enter and on Save, with the field text', () => {
    field().value = 'Paweł';
    field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    q('speaker-name-save')!.click();
    expect(events).toEqual(['saved:Paweł', 'saved:Paweł']);
  });

  it('never saves on blur', () => {
    field().dispatchEvent(new Event('blur'));
    expect(events).toEqual([]);
  });

  it('tells Cancel apart from Esc and a press outside, and ignores a press inside', () => {
    q('speaker-name-cancel')!.click();
    q('speaker-name-dialog')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    field().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(events).toEqual(['cancelled', 'dismissed', 'dismissed']);
  });

  it('puts an offered name in the field and keeps the focus there', () => {
    fixture.componentRef.setInput('suggestions', ['Marta', 'Ola']);
    fixture.detectChanges();
    expect(q('speaker-name-suggestions')!.textContent).toContain(
      'Names from the previous transcript'
    );
    const offered = fixture.nativeElement.querySelectorAll(
      '[data-testid="speaker-name-suggestion"]'
    );
    (offered[1] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(field().value).toBe('Ola');
    expect(document.activeElement).toBe(field());
    expect(q('speaker-name-note')!.textContent?.trim()).toBe('typed: Ola');
    expect(events).toEqual([]);
  });

  it('shows no offered names when there are none', () => {
    expect(q('speaker-name-suggestions')).toBeNull();
  });
});
